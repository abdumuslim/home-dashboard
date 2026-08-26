import { describe, it, expect } from "vitest";
import {
  FAN_RESTORE_AFTER_CUT_MS,
  FAN_RESTORE_CALM_MS,
  FAN_RESTORE_CONTINUE_CALM_MS,
  FAN_RESTORE_GENTLE_CALM_MS,
  FAN_RESTORE_MAX_STEP,
  FAN_RESTORE_RESEND_MS,
  noteEscalation,
  planFanRestore,
  recordFanCut,
  recordGentleRestoreHold,
  releaseFanHold,
  type FanHolds,
} from "./fan-trim.js";
import { updateCost } from "./costs.js";
import type { AcView } from "./types.js";

const T = 1_000_000;

function ac(id: string, overrides: Partial<AcView> = {}): AcView {
  return {
    deviceId: id,
    name: id,
    on: true,
    managed: true,
    shed: false,
    maxLevel: 3,
    currentLevel: 1,
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
    envelopeLevel: overrides.envelopeLevel ?? overrides.currentLevel ?? 1,
    rankNeedDelta: overrides.rankNeedDelta ?? overrides.needDelta ?? 1,
  };
}

describe("hold records", () => {
  it("the first cut snapshots the original fan; later cuts keep it", () => {
    let holds: FanHolds = recordFanCut({}, ac("a", { fanSpeed: 6 }), 3, T);
    expect(holds.a.originalFan).toBe(6);
    holds = recordFanCut(holds, ac("a", { fanSpeed: 3 }), 1, T + 60_000);
    expect(holds.a.originalFan).toBe(6);
    expect(holds.a.lastSetFan).toBe(1);
    expect(releaseFanHold(holds, "a").a).toBeUndefined();
  });
});

describe("planFanRestore", () => {
  const opts = (over: Partial<Parameters<typeof planFanRestore>[2]> = {}) => ({
    calmMs: FAN_RESTORE_CALM_MS,
    headroomAmps: 1,
    flickerMarginAmps: 0,
    book: {},
    source: "gen" as const,
    now: T,
    ...over,
  });

  /** A cut old enough that only the calm gate and the cost can block. */
  const cutLongAgo = (fanSpeed: number) =>
    recordFanCut({}, ac("a", { fanSpeed }), 1, T - FAN_RESTORE_AFTER_CUT_MS);

  it("does nothing before the long calm gate (v1's 61s bounce median is the disease)", () => {
    expect(
      planFanRestore(cutLongAgo(6), [ac("a", { fanSpeed: 1 })], opts({ calmMs: FAN_RESTORE_CALM_MS - 1 })),
    ).toBeNull();
  });

  it("holds a freshly-cut fan for the cut cooldown even when the meter is calm", () => {
    // Live 2026-07-31: Abdu's fan was cut at 17:30:24 and fully restored at
    // 17:31:44 — 80s. A fan-only batch never rewinds the shared calm clock, so the
    // calm gate alone could not see the cut that had just happened;
    // FAN_RESTORE_AFTER_CUT_MS (120s) is what does.
    // 0.8A of room: enough for the bounded climb, short of the 0.5A swing plus
    // FAN_RESTORE_FAST_MARGIN_AMPS (0.5) that would buy the shorter fast window —
    // so this hold owes the full 120s, and 80s ago is still inside it.
    const justCut = recordFanCut({}, ac("a", { fanSpeed: 7 }), 1, T - 80_000);
    expect(planFanRestore(justCut, [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 0.8 }))).toBeNull();
    const cooled = recordFanCut({}, ac("a", { fanSpeed: 7 }), 1, T - FAN_RESTORE_AFTER_CUT_MS);
    expect(planFanRestore(cooled, [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 0.8 }))).not.toBeNull();
  });

  it("a climb already under way does not re-pay the full anti-bounce window per gear", () => {
    // Live 2026-08-03 05:16:29 → 05:17:33: two gears of one recovery, a minute
    // apart, because every gear was charged the 60s gate. A fan restore SPENDS,
    // so each one also rewinds the shared calm clock — which is why the raise
    // path got no window for the length of the climb. The long gate decides
    // whether a cut fan may come back AT ALL; once the first gear has proved
    // itself the remaining question is only whether the last one has landed.
    // 0.2A/gear against 1A of room — a bounded 1→3 climb, not the fast full swing
    // (which at the seed price would fit) — so this exercises a genuine second gear.
    const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
    const cut = cutLongAgo(7);
    const first = planFanRestore(cut, [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 1 }));
    expect(first!.command).toMatchObject({ fan: 1 + FAN_RESTORE_MAX_STEP });
    const climbing = first!.holds;
    // The next gear goes at the short gate… but the continuation gate now ALSO
    // owes its own last-gear spacing (2026-08-09): the fan calm clock survives a
    // fan-only spend, so `fanCalmMs` no longer rewinds when this hold's own gear
    // landed — the second gear must be evaluated CONTINUE_CALM_MS after the first
    // (`first` fired at T, so evaluate at T + CONTINUE_CALM_MS). The shadow has
    // CONFIRMED the first gear (fanSpeed 3 == lastSetFan 3), so the confirm-or-
    // resend gate is inert here.
    const gearNow = T + FAN_RESTORE_CONTINUE_CALM_MS;
    expect(
      planFanRestore(climbing, [ac("a", { fanSpeed: 3 })], opts({ book, calmMs: FAN_RESTORE_CONTINUE_CALM_MS, headroomAmps: 1, now: gearNow })),
    ).not.toBeNull();
    // …but not instantly: it still has to see the meter agree (the calm gate).
    expect(
      planFanRestore(climbing, [ac("a", { fanSpeed: 3 })], opts({ book, calmMs: FAN_RESTORE_CONTINUE_CALM_MS - 1, headroomAmps: 1, now: gearNow })),
    ).toBeNull();
  });

  it("a fresh cut ends the climb, so the next restore re-earns the long gate", () => {
    const cut = cutLongAgo(7);
    const first = planFanRestore(cut, [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 5 }));
    const recut = recordFanCut(first!.holds, ac("a", { fanSpeed: 3 }), 1, T - FAN_RESTORE_AFTER_CUT_MS);
    expect(recut.a.climbStartedAt).toBeUndefined();
    expect(
      planFanRestore(recut, [ac("a", { fanSpeed: 1 })], opts({ calmMs: FAN_RESTORE_CONTINUE_CALM_MS, headroomAmps: 5 })),
    ).toBeNull();
  });

  it("climbs at most FAN_RESTORE_MAX_STEP gears while the budget merely COVERS the swing", () => {
    // The bug: the old search took the HIGHEST target whose cost fits, and a
    // 6-gear swing prices at ~0.9A — so 1→7 fitted essentially always. Abdu ran
    // 7→5→3→1→7→1→7→4 in nine minutes on 2026-07-31.
    // 0.6A of swing against 1.0A of room: it fits, which is exactly the case the
    // bound exists for. Only swing + FAN_RESTORE_FAST_MARGIN_AMPS (0.5 → 1.1A) lifts it.
    const book = updateCost({}, "a", "gen", "fan:step", 0.1, T);
    const step = planFanRestore(cutLongAgo(7), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 1.0 }));
    expect(step!.command).toMatchObject({ kind: "set_fan", fan: 1 + FAN_RESTORE_MAX_STEP });
    expect(step!.final).toBe(false);
    expect(step!.holds.a.lastSetFan).toBe(1 + FAN_RESTORE_MAX_STEP);
  });

  it("takes a smaller step when the bounded one does not fit", () => {
    // Learned 0.2A/step, headroom 0.3A: 2 gears cost 0.4 (no), 1 gear 0.2 (yes).
    const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
    const step = planFanRestore(cutLongAgo(6), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 0.3 }));
    expect(step!.command).toMatchObject({ fan: 2 });
  });

  it("marks the step final only when it actually reaches the original", () => {
    const book = updateCost({}, "a", "gen", "fan:step", 0.1, T);
    const step = planFanRestore(cutLongAgo(3), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 2 }));
    expect(step!.command).toMatchObject({ fan: 3 });
    expect(step!.final).toBe(true);
  });

  it("built-in auto restores as one indivisible jump (there is no half of auto)", () => {
    const step = planFanRestore(cutLongAgo(0), [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 2 }));
    expect(step!.command).toMatchObject({ fan: 0 });
    expect(step!.final).toBe(true);
  });

  it("does not move when not even one step fits", () => {
    const book = updateCost({}, "a", "gen", "fan:step", 0.5, T);
    expect(
      planFanRestore(cutLongAgo(6), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 0.3 })),
    ).toBeNull();
  });

  it("charges the live supply flicker against the restore headroom (2026-08-06 fan bounce)", () => {
    // 13:12-13:34Z: three rooms at their floors on a saturated 15A generator,
    // so a fan trim was the only rung the reducer had left. The trim dipped the
    // meter, calm rebuilt, and the restore was admitted at `cost <= headroom`
    // into a mean sitting 0.7-1.1A under the ceiling on a line whose measured
    // flicker was 0.96A. The re-cross was arithmetic, and Abdu's fan was
    // commanded ten times in twenty-two minutes.
    const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
    // 0.4A of room admits a 0.2A gear on a quiet line…
    expect(
      planFanRestore(cutLongAgo(6), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 0.4 })),
    ).not.toBeNull();
    // …and none of it once ±0.3A of supply flicker is charged first.
    expect(
      planFanRestore(cutLongAgo(6), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 0.4, flickerMarginAmps: 0.3 })),
    ).toBeNull();
  });

  it("charges the flicker on the auto-jump branch too (Abdullah's 0↔1 half of the same 22 minutes)", () => {
    // originalFan 0 is one indivisible swing priced at the full-drop default
    // (0.5A). It has to answer the same question as a numeric climb: a gentle
    // hand-back into the flicker band re-arms exactly the same cycle.
    expect(
      planFanRestore(cutLongAgo(0), [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 0.6 })),
    ).not.toBeNull();
    expect(
      planFanRestore(cutLongAgo(0), [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 0.6, flickerMarginAmps: 0.3 })),
    ).toBeNull();
  });

  it("flicker shrinks the climb, it does not kill it", () => {
    // 0.2A/gear against 0.5A of room: two gears fit on a quiet line, one fits
    // once 0.2A of flicker is charged. The bounded sweet-spot search is what
    // makes the fan park at the highest gear that TRULY fits — no new gate.
    const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
    expect(
      planFanRestore(cutLongAgo(6), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 0.5 }))!.command,
    ).toMatchObject({ fan: 3 });
    expect(
      planFanRestore(cutLongAgo(6), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 0.5, flickerMarginAmps: 0.2 }))!
        .command,
    ).toMatchObject({ fan: 2 });
  });

  it("charges the flicker to a fromCut hold but NOT a gentle pin (2026-08-08)", () => {
    // A gentle hold is a fan pinned to 1 on a gen restore — admission pricing,
    // never overload relief — so it is judged on BARE headroom. Invariant 58
    // itself flagged that charging it the wobble left it "pinned at fan 1 longer
    // than it did"; the user has now reported exactly that ("fan 1 is
    // emergency-only and should not take too long to come back").
    // 0.6A of room fits the 0.5A auto swing on its own, but not once 0.8A of
    // supply flicker is charged first.
    const gentle = recordGentleRestoreHold({}, "a", T - 600_000, false);
    expect(
      planFanRestore(gentle, [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 0.6, flickerMarginAmps: 0.8 })),
    ).not.toBeNull();
    // The 2026-08-06 bounce lived entirely on the fromCut side, so its margin
    // stays: the identical figures on a cut hold still refuse.
    expect(
      planFanRestore(cutLongAgo(0), [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 0.6, flickerMarginAmps: 0.8 })),
    ).toBeNull();
  });

  it("a gentle first gear releases at the shorter GENTLE calm; a fromCut first gear still owes the minute", () => {
    // The 60s "may this fan come back at all" gate was sized for the fromCut
    // bounce. A gentle pin has no bounce to guard against, so its first gear owes
    // only FAN_RESTORE_GENTLE_CALM_MS (= the default raiseCalmSeconds).
    const gentle = recordGentleRestoreHold({}, "a", T - 600_000, false);
    // 30s: past the gentle gate, and short of the fromCut minute.
    expect(
      planFanRestore(gentle, [ac("a", { fanSpeed: 1 })], opts({ calmMs: FAN_RESTORE_GENTLE_CALM_MS, headroomAmps: 2 })),
    ).not.toBeNull();
    // …but not one tick before it.
    expect(
      planFanRestore(gentle, [ac("a", { fanSpeed: 1 })], opts({ calmMs: FAN_RESTORE_GENTLE_CALM_MS - 1, headroomAmps: 2 })),
    ).toBeNull();
    // A fromCut hold in the same 30s window still refuses — its full minute is
    // the anti-bounce guard and is not shortened.
    expect(
      planFanRestore(cutLongAgo(0), [ac("a", { fanSpeed: 1 })], opts({ calmMs: FAN_RESTORE_GENTLE_CALM_MS, headroomAmps: 2 })),
    ).toBeNull();
  });

  it("a gentle hold's continuation gear still pays only the short 20s gate", () => {
    // A real gentle hold restores auto in one indivisible jump, so this exercises
    // the continuation gate directly with a mid-climb numeric-origin hold: once a
    // climb is under way the question is only "has the last gear landed", which is
    // kind-independent — both fromCut and gentle pay FAN_RESTORE_CONTINUE_CALM_MS.
    const climbing: FanHolds = {
      a: { deviceId: "a", originalFan: 6, lastSetFan: 3, heldAt: T - 600_000, fromCut: false, climbStartedAt: T - 600_000 },
    };
    expect(
      planFanRestore(climbing, [ac("a", { fanSpeed: 3 })], opts({ calmMs: FAN_RESTORE_CONTINUE_CALM_MS, headroomAmps: 2 })),
    ).not.toBeNull();
    expect(
      planFanRestore(climbing, [ac("a", { fanSpeed: 3 })], opts({ calmMs: FAN_RESTORE_CONTINUE_CALM_MS - 1, headroomAmps: 2 })),
    ).toBeNull();
  });

  it("does not hand a fan back into the compressor's OWN ramp (2026-08-06 14:03:20Z)", () => {
    // The gentle hold's whole purpose is to keep the range automation off the
    // fan "while the compressor is still ramping" — but the release was only
    // calm- and headroom-gated, so Najat's fan went to auto 134 s into her own
    // 240 s ramp and helped push the smoothed meter to 15.3 A, which re-shed
    // her. A peer's ramp is charged through `rampDebit`; this is the SELF case,
    // which no debit covers because the room's own draw is what the fan sits on.
    const hold = recordGentleRestoreHold({}, "a", T - 200_000, false);
    expect(
      planFanRestore(hold, [ac("a", { fanSpeed: 1, ramping: true })], opts({ headroomAmps: 5 })),
    ).toBeNull();
    expect(
      planFanRestore(hold, [ac("a", { fanSpeed: 1, ramping: false })], opts({ headroomAmps: 5 })),
    ).not.toBeNull();
  });

  it("…and a fromCut hold obeys the same gate (a power event ramps it exactly the same)", () => {
    const cut = cutLongAgo(6);
    expect(
      planFanRestore(cut, [ac("a", { fanSpeed: 1, ramping: true })], opts({ headroomAmps: 5 })),
    ).toBeNull();
    expect(
      planFanRestore(cut, [ac("a", { fanSpeed: 1, ramping: false })], opts({ headroomAmps: 5 })),
    ).not.toBeNull();
  });

  it("takes the whole remaining swing in ONE step when the budget is generous (2026-08-06)", () => {
    // The user, watching his fans crawl back after an episode: "there is enough
    // budget but the fan speed is taking too long … the fan speed is barely
    // taking cost". The book agrees — a full 1→7 swing graded +0.64A that
    // afternoon, under half a compressor level — yet recovery cost ~5 minutes
    // of time gates whether the budget was razor-thin or wide open. When the
    // room covers the WHOLE swing with a full amp of slack net of flicker, the
    // gear bound is protecting against a re-cross that arithmetic rules out.
    const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
    // 6 gears × 0.2 = 1.2A of swing, 1.2 + FAST_MARGIN 1.0 = 2.2A ≤ 3A of room.
    const step = planFanRestore(cutLongAgo(7), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 3 }));
    expect(step!.command).toMatchObject({ kind: "set_fan", fan: 7 });
    expect(step!.final).toBe(true);
    expect(step!.holds.a.lastSetFan).toBe(7);
    expect(step!.action).toContain("fast");
  });

  it("a generous budget owes the SHORT after-cut wait; a thin one still owes the full 120s", () => {
    const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
    const cutAt = (ago: number) => recordFanCut({}, ac("a", { fanSpeed: 7 }), 1, T - ago);
    // 70s after the last cut: past FAN_RESTORE_AFTER_CUT_FAST_MS (60s), short of
    // the full 120s. A generous 3A budget covers the 1.2A swing + the 0.5A fast
    // margin, so it climbs home on the SHORT window…
    expect(
      planFanRestore(cutAt(70_000), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 3 })),
    ).not.toBeNull();
    // 1.5A of room does not cover 1.2A of swing plus the 0.5A margin, so this hold
    // owes the full anti-bounce window every episode has always owed…
    expect(
      planFanRestore(cutAt(70_000), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 1.5 })),
    ).toBeNull();
    // …and gets its ordinary bounded climb once that window is behind it.
    expect(
      planFanRestore(cutAt(FAN_RESTORE_AFTER_CUT_MS), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 1.5 })),
    ).not.toBeNull();
  });

  it("'generous' is judged NET of the flicker, and falls back to the bounded climb — not to nothing", () => {
    // Same 3A of headroom as the fast-path case, on a line wobbling ±1.5A. The
    // fast path is unreachable there by construction (invariant 24: the mean is
    // the truth about load), and the thin path still applies normally.
    const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
    const step = planFanRestore(
      cutLongAgo(7),
      [ac("a", { fanSpeed: 1 })],
      opts({ book, headroomAmps: 3, flickerMarginAmps: 1.5 }),
    );
    expect(step!.command).toMatchObject({ fan: 1 + FAN_RESTORE_MAX_STEP });
    expect(step!.final).toBe(false);
    expect(step!.action).not.toContain("fast");
  });

  it("a generous budget still never hands a fan back into the room's OWN ramp", () => {
    // The fast path shortens time gates; it does not overrule physics nothing
    // else charges (2026-08-06 14:03:20Z, Najat's fan 134s into her own ramp).
    const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
    const justCut = recordFanCut({}, ac("a", { fanSpeed: 7 }), 1, T - 70_000);
    expect(
      planFanRestore(justCut, [ac("a", { fanSpeed: 1, ramping: true })], opts({ book, headroomAmps: 3 })),
    ).toBeNull();
  });

  it("a re-cut within the bounce window compounds the after-cut wait; a survived restore resets it (2026-08-08)", () => {
    const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
    // A fan restored a gear 60s ago (lastRestoreAt), then re-cut now → a bounce
    // (60s < FAN_BOUNCE_WINDOW_MS 180s), so the counter climbs to 1.
    const restored: FanHolds = {
      a: {
        deviceId: "a", originalFan: 7, lastSetFan: 5, heldAt: T - 600_000, fromCut: true,
        lastCutAt: T - 400_000, lastRestoreAt: T - 60_000, bounces: 0,
      },
    };
    const bounced = recordFanCut(restored, ac("a", { fanSpeed: 5 }), 1, T);
    expect(bounced.a.bounces).toBe(1);
    // One bounce DOUBLES the base after-cut (thin 120s → 240s): a cut 130s ago is
    // past the base but short of the compounded wait → still held…
    const heldBounced: FanHolds = { a: { ...bounced.a, lastCutAt: T - 130_000 } };
    expect(planFanRestore(heldBounced, [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 1 }))).toBeNull();
    // …while the SAME 130s-old cut with no bounces restores on the ordinary 120s.
    const heldFresh: FanHolds = { a: { ...bounced.a, bounces: 0, lastCutAt: T - 130_000 } };
    expect(planFanRestore(heldFresh, [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 1 }))).not.toBeNull();
    // A re-cut OUTSIDE the window (the prior restore survived) resets the counter.
    const survived = recordFanCut(
      { a: { ...restored.a, lastRestoreAt: T - 300_000 } },
      ac("a", { fanSpeed: 5 }),
      1,
      T,
    );
    expect(survived.a.bounces).toBe(0);
  });

  it("skips OFF ACs and ACs without holds", () => {
    expect(planFanRestore(cutLongAgo(6), [ac("a", { on: false }), ac("b")], opts())).toBeNull();
  });

  // A set_fan shadow can lag minutes on TCL, and the climb reads the OBSERVED
  // shadow to pick the next gear — so without a plan-level in-flight gate an
  // unconfirmed step re-emits the SAME command every own-gear tick, re-arming the
  // fan debit and (via change C) deferring an admissible raise on a phantom step.
  // Confirm-or-resend holds the climb until FAN_RESTORE_RESEND_MS (2026-08-09).
  describe("confirm-or-resend gate for an unconfirmed step (2026-08-09)", () => {
    const midClimb = (lastRestoreAt: number): FanHolds => ({
      a: {
        deviceId: "a", originalFan: 6, lastSetFan: 5, heldAt: T - 600_000, fromCut: true,
        lastCutAt: T - 600_000, climbStartedAt: T - 600_000, lastRestoreAt,
      },
    });

    it("does not re-emit while the last step is unconfirmed and inside the resend window", () => {
      // Commanded fan 5, shadow still at 3 (unconfirmed), last step 30s ago —
      // past the 20s own-gear gate but short of the 60s resend window.
      expect(
        planFanRestore(midClimb(T - 30_000), [ac("a", { fanSpeed: 3 })], opts({ calmMs: FAN_RESTORE_CALM_MS, headroomAmps: 1 })),
      ).toBeNull();
    });

    it("resends once the window has elapsed", () => {
      expect(
        planFanRestore(midClimb(T - FAN_RESTORE_RESEND_MS), [ac("a", { fanSpeed: 3 })], opts({ calmMs: FAN_RESTORE_CALM_MS, headroomAmps: 1 })),
      ).not.toBeNull();
    });

    it("a CONFIRMED shadow climbs the next gear at the ordinary 20s gate", () => {
      // Shadow caught up to the commanded 5 → not in-flight, so the next gear
      // (5→6) goes at the own-gear continue gate, not the resend window.
      expect(
        planFanRestore(midClimb(T - FAN_RESTORE_CONTINUE_CALM_MS), [ac("a", { fanSpeed: 5 })], opts({ calmMs: FAN_RESTORE_CALM_MS, headroomAmps: 1 })),
      ).not.toBeNull();
    });
  });

  // The fan calm clock now SURVIVES a fan-only spend so a fan hold does not queue
  // behind another hold's fan step ("fans do not queue behind fans", 2026-08-09).
  // That decouples `fanCalmMs` from when THIS hold's own last gear landed, so a
  // continuation gear must ALSO owe its own `lastRestoreAt` spacing — otherwise a
  // climb could take a gear every tick.
  describe("continuation gear owes its own last-gear spacing (2026-08-09)", () => {
    const midClimb = (lastRestoreAt: number): FanHolds => ({
      a: {
        deviceId: "a", originalFan: 6, lastSetFan: 3, heldAt: T - 600_000, fromCut: true,
        lastCutAt: T - 600_000, climbStartedAt: T - 600_000, lastRestoreAt,
      },
    });

    it("refuses a gear whose own last gear landed less than the continue gate ago", () => {
      // calm long satisfied; the ONLY blocker is that this hold's last gear fired
      // 19s ago, short of FAN_RESTORE_CONTINUE_CALM_MS (20s).
      expect(
        planFanRestore(midClimb(T - 19_000), [ac("a", { fanSpeed: 3 })], opts({ calmMs: FAN_RESTORE_CALM_MS, headroomAmps: 1 })),
      ).toBeNull();
    });

    it("admits it once the own-gear spacing is met", () => {
      expect(
        planFanRestore(midClimb(T - FAN_RESTORE_CONTINUE_CALM_MS), [ac("a", { fanSpeed: 3 })], opts({ calmMs: FAN_RESTORE_CALM_MS, headroomAmps: 1 })),
      ).not.toBeNull();
    });
  });

  // FIX B (2026-08-26): the reduction ladder is levels → fans → sub-floor → off,
  // so a batch that cut a level or shed a room escalated PAST the fan. A held fan
  // whose episode escalated is no longer the binding relief, so its first gear
  // owes only the 30s gentle calm and (with no bounce on record) skips the
  // after-cut wait. Live: a fan cut to 1 at 14:28:12Z, a room shed 10s later
  // freeing ~2.3A, and the fan then sat at 1 until 14:36:37Z (user: "the fan speed
  // should be back right after any other reduction, no need to wait any time").
  describe("a fan comes home right after a deeper cut (FIX B, 2026-08-26)", () => {
    it("noteEscalation stamps every hold and returns the same object when empty", () => {
      const empty: FanHolds = {};
      expect(noteEscalation(empty, T)).toBe(empty);
      const cut = recordFanCut({}, ac("a", { fanSpeed: 7 }), 1, T - 10_000);
      const stamped = noteEscalation(cut, T);
      expect(stamped.a.escalatedAt).toBe(T);
    });

    it("an escalated hold with bounces 0 comes home on the 30s gentle calm with no after-cut wait", () => {
      const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
      // A fromCut hold cut 10s ago (well inside the 120s after-cut wait), escalated
      // in the same batch (escalatedAt == lastCutAt).
      const cut = recordFanCut({}, ac("a", { fanSpeed: 7 }), 1, T - 10_000);
      const escalated = noteEscalation(cut, T - 10_000);
      const step = planFanRestore(
        escalated,
        [ac("a", { fanSpeed: 1 })],
        opts({ book, calmMs: FAN_RESTORE_GENTLE_CALM_MS, headroomAmps: 5 }),
      );
      expect(step).not.toBeNull();
      // LOUD: the escalation is what admitted it now, so the action says so.
      expect(step!.action).toContain("after deeper cut");
      // Without the escalation the identical fresh cut at 30s calm still owes the
      // full 60s first-gear minute, so it refuses: byte-identical to before.
      const plain: FanHolds = { a: { ...escalated.a, escalatedAt: undefined } };
      expect(
        planFanRestore(plain, [ac("a", { fanSpeed: 1 })], opts({ book, calmMs: FAN_RESTORE_GENTLE_CALM_MS, headroomAmps: 5 })),
      ).toBeNull();
    });

    it("an escalated hold with a bounce on record still owes the full compounded wait", () => {
      const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
      // One bounce doubles the base 120s wait to 240s. A proven bouncer keeps its
      // net even when escalated (SETTLE, don't bounce), so a cut 10s ago is held.
      const bounced: FanHolds = {
        a: {
          deviceId: "a", originalFan: 7, lastSetFan: 1, heldAt: T - 300_000, fromCut: true,
          lastCutAt: T - 10_000, bounces: 1, escalatedAt: T - 10_000,
        },
      };
      expect(
        planFanRestore(bounced, [ac("a", { fanSpeed: 1 })], opts({ book, calmMs: FAN_RESTORE_CALM_MS, headroomAmps: 1 })),
      ).toBeNull();
      // Drop the bounce and the after-cut wait is skipped: it comes home.
      const unbounced: FanHolds = { a: { ...bounced.a, bounces: 0 } };
      expect(
        planFanRestore(unbounced, [ac("a", { fanSpeed: 1 })], opts({ book, calmMs: FAN_RESTORE_CALM_MS, headroomAmps: 1 })),
      ).not.toBeNull();
    });

    it("a fresh cut after the escalation restores the full gates (escalatedAt does not carry forward)", () => {
      const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
      const escalated: FanHolds = {
        a: {
          deviceId: "a", originalFan: 7, lastSetFan: 1, heldAt: T - 300_000, fromCut: true,
          lastCutAt: T - 200_000, bounces: 0, escalatedAt: T - 200_000,
        },
      };
      // A brand-new cut lands AFTER the escalation; recordFanCut drops escalatedAt.
      const recut = recordFanCut(escalated, ac("a", { fanSpeed: 1 }), 1, T - 10_000);
      expect(recut.a.escalatedAt).toBeUndefined();
      // So the fresh cut owes the full 60s first-gear minute again: 30s calm refuses.
      expect(
        planFanRestore(recut, [ac("a", { fanSpeed: 1 })], opts({ book, calmMs: FAN_RESTORE_GENTLE_CALM_MS, headroomAmps: 5 })),
      ).toBeNull();
    });

    it("an escalation OLDER than the last cut does not relax the gates (byte-identical to non-escalated)", () => {
      const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
      // escalatedAt (200s ago) predates lastCutAt (10s ago), so the reducer did NOT
      // go past THIS fan since the cut: not escalated. Owes the 60s minute.
      const stale: FanHolds = {
        a: {
          deviceId: "a", originalFan: 7, lastSetFan: 1, heldAt: T - 300_000, fromCut: true,
          lastCutAt: T - 10_000, bounces: 0, escalatedAt: T - 200_000,
        },
      };
      expect(
        planFanRestore(stale, [ac("a", { fanSpeed: 1 })], opts({ book, calmMs: FAN_RESTORE_GENTLE_CALM_MS, headroomAmps: 5 })),
      ).toBeNull();
    });
  });
});
