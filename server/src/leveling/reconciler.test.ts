import { describe, it, expect } from "vitest";
import {
  FAN_RESEND_MAX,
  LEVEL_RESEND_SPACING_MS,
  UNREACHABLE_LEVEL_SENDS,
  UNREACHABLE_SAFETY_EXPIRY_MS,
  clearMarksOnManual,
  clearOnPowerOff,
  clearOnSourceChange,
  confirmFan,
  fanResendDue,
  initialReconcilerState,
  noteFanSend,
  noteLevelSend,
  observeLevel,
  reachableCapOf,
  shouldSendLevel,
  sweepExpiredMarks,
  UNCONFIRMED_SEND_TTL_MS,
  unconfirmedLevels,
  type ReconcilerState,
} from "./reconciler.js";

const T = 1_000_000;
const opts = { inSettle: false, collapsed: false, maxLevel: 3 };

/** Adopt a confirmed baseline for device "a" at `level`. */
function adopted(level: number): ReconcilerState {
  return observeLevel(initialReconcilerState(), "a", level, opts).state;
}

describe("confirmation-gated drift detection (ported v1 semantics)", () => {
  it("first observation adopts the baseline (but not inside settle)", () => {
    const inSettle = observeLevel(initialReconcilerState(), "a", 2, { ...opts, inSettle: true });
    expect(inSettle.result.kind).toBe("none");
    const r = observeLevel(initialReconcilerState(), "a", 2, opts);
    expect(r.result.kind).toBe("adopted");
  });

  it("a lagging/ignored command leaves obs === confirmed → no intent, ever", () => {
    let s = adopted(1);
    s = noteLevelSend(s, "a", 2, T).state; // command in flight
    const r = observeLevel(s, "a", 1, opts); // shadow still shows the old level
    expect(r.result.kind).toBe("none");
  });

  it("our command landing promotes the baseline with no manual intent", () => {
    let s = adopted(1);
    s = noteLevelSend(s, "a", 2, T).state;
    const r = observeLevel(s, "a", 2, opts);
    expect(r.result).toMatchObject({ kind: "landed", level: 2 });
  });

  it("observed level 0 is NEVER a manual intent (the 31A grid incident)", () => {
    let s = adopted(2);
    s = noteLevelSend(s, "a", 3, T).state;
    const r = observeLevel(s, "a", 0, opts);
    expect(r.result.kind).toBe("adopted");
    // pending is kept: a later landing still confirms with no intent.
    const later = observeLevel(r.state, "a", 3, opts);
    expect(later.result.kind).toBe("landed");
  });

  it("no intent minting while a collapse is latched — but our late command still confirms", () => {
    let s = adopted(2);
    s = noteLevelSend(s, "a", 1, T).state;
    // A stuck shadow jumps to 3 mid-collapse (the false 'target L3' of 2026-07-10):
    const r = observeLevel(s, "a", 3, { ...opts, collapsed: true });
    expect(r.result.kind).toBe("adopted");
    // After recovery our own L1 lands → confirm, no intent:
    const landed = observeLevel(r.state, "a", 1, opts);
    expect(landed.result.kind).toBe("landed");
  });

  it("a genuine external reduction mints a cap; an increment mints a target", () => {
    const down = observeLevel(adopted(3), "a", 2, opts);
    expect(down.result).toMatchObject({ kind: "manual", intent: "cap", level: 2 });
    const up = observeLevel(adopted(1), "a", 3, opts);
    expect(up.result).toMatchObject({ kind: "manual", intent: "target", level: 3 });
  });
});

describe("unreachable levels", () => {
  it("marks after UNREACHABLE_LEVEL_SENDS unconfirmed sends and falls back one level", () => {
    let s = adopted(1);
    let marked = false;
    let fallback: number | null = null;
    for (let i = 0; i < UNREACHABLE_LEVEL_SENDS; i++) {
      const r = noteLevelSend(s, "a", 3, T + i * 40_000);
      s = r.state;
      marked = r.marked;
      fallback = r.fallback;
    }
    expect(marked).toBe(true);
    expect(fallback).toBe(2);
    expect(reachableCapOf(s, "a", 3)).toBe(2);
  });

  it("L1 is never marked (a managed AC must always get SOME cap)", () => {
    let s = adopted(2);
    for (let i = 0; i < UNREACHABLE_LEVEL_SENDS + 2; i++) {
      const r = noteLevelSend(s, "a", 1, T + i * 40_000);
      s = r.state;
      expect(r.marked).toBe(false);
    }
    expect(reachableCapOf(s, "a", 3)).toBeNull();
  });

  it("send counts are PER LEVEL — target flutter can't evade detection", () => {
    let s = adopted(1);
    // Alternate 3,2,3,2… — each level's count grows independently.
    for (let i = 0; i < 3; i++) {
      s = noteLevelSend(s, "a", 3, T + i * 40_000).state;
      s = noteLevelSend(s, "a", 2, T + i * 40_000 + 20_000).state;
    }
    const r = noteLevelSend(s, "a", 3, T + 200_000);
    expect(r.marked).toBe(true);
  });

  it("a late confirm of a marked level un-marks it with NO manual intent (Najat's slow L4)", () => {
    let s = adopted(1);
    for (let i = 0; i < UNREACHABLE_LEVEL_SENDS; i++) s = noteLevelSend(s, "a", 3, T + i * 40_000).state;
    // Fallback already moved pending to 2:
    s = noteLevelSend(s, "a", 2, T + 200_000).state;
    const r = observeLevel(s, "a", 3, opts);
    expect(r.result).toMatchObject({ kind: "late_confirm", level: 3 });
    expect(reachableCapOf(r.state, "a", 3)).toBeNull();
  });

  it("marks expire after 60 min and get re-probed", () => {
    let s = adopted(1);
    for (let i = 0; i < UNREACHABLE_LEVEL_SENDS; i++) s = noteLevelSend(s, "a", 3, T + i * 1_000).state;
    const swept = sweepExpiredMarks(s, T + UNREACHABLE_SAFETY_EXPIRY_MS + 3_000 + 1);
    expect(swept.expired).toEqual([{ deviceId: "a", level: 3 }]);
    expect(reachableCapOf(swept.state, "a", 3)).toBeNull();
  });

  it("marks survive power cycles and source changes; baselines do not", () => {
    let s = adopted(2);
    for (let i = 0; i < UNREACHABLE_LEVEL_SENDS; i++) s = noteLevelSend(s, "a", 3, T + i * 1_000).state;
    const offd = clearOnPowerOff(s, "a");
    expect(reachableCapOf(offd, "a", 3)).toBe(2);
    expect(observeLevel(offd, "a", 1, opts).result.kind).toBe("adopted"); // baseline re-adopts
    const flipped = clearOnSourceChange(s);
    expect(reachableCapOf(flipped, "a", 3)).toBe(2);
    // A manual gen change is a user probe — marks reset:
    expect(reachableCapOf(clearMarksOnManual(s, "a"), "a", 3)).toBeNull();
  });
});

describe("send pacing", () => {
  it("dedupes re-sends of the same level inside the spacing window", () => {
    let s = adopted(3);
    s = noteLevelSend(s, "a", 1, T).state;
    expect(shouldSendLevel(s, "a", 1, T + LEVEL_RESEND_SPACING_MS - 1)).toBe(false);
    expect(shouldSendLevel(s, "a", 1, T + LEVEL_RESEND_SPACING_MS)).toBe(true);
    expect(shouldSendLevel(s, "a", 2, T + 1_000)).toBe(true); // different level passes
  });
});

describe("fan confirm-or-resend", () => {
  it("resends a bounded number of times, spaced, then gives up", () => {
    let s = noteFanSend(initialReconcilerState(), "a", 1, T);
    expect(fanResendDue(s, "a", 5, T + 5_000)).toBeNull(); // spacing not met
    expect(fanResendDue(s, "a", 5, T + 15_000)).toBe(1);
    s = noteFanSend(s, "a", 1, T + 15_000);
    s = noteFanSend(s, "a", 1, T + 30_000);
    expect(s.a.fanResends).toBe(FAN_RESEND_MAX);
    expect(fanResendDue(s, "a", 5, T + 60_000)).toBeNull(); // budget exhausted
  });

  it("an observed confirm clears the pending fan", () => {
    let s = noteFanSend(initialReconcilerState(), "a", 4, T);
    s = confirmFan(s, "a", 4);
    expect(fanResendDue(s, "a", 2, T + 60_000)).toBeNull();
  });
});

describe("unconfirmed levels (physics-envelope pricing)", () => {
  it("reports a level we sent and never saw confirm", () => {
    const s = noteLevelSend(adopted(1), "a", 3, T).state;
    expect(unconfirmedLevels(s, "a", T + 1_000)).toEqual([3]);
  });

  it("a confirm clears it", () => {
    let s = noteLevelSend(adopted(1), "a", 3, T).state;
    s = observeLevel(s, "a", 3, opts).state;
    expect(unconfirmedLevels(s, "a", T + 1_000)).toEqual([]);
  });

  it("a LATER demote send does not erase the earlier unconfirmed raise", () => {
    // 2026-07-28: an L3 sent at 15:39:49 was still unconfirmed 15.8 min later.
    // `pendingLevel` is one slot — a demote overwrites it and the envelope
    // would price the room a whole ton light. sendCounts keeps both.
    let s = noteLevelSend(adopted(1), "a", 3, T).state;
    s = noteLevelSend(s, "a", 1, T + 60_000).state;
    expect(unconfirmedLevels(s, "a", T + 61_000).sort()).toEqual([1, 3]);
    expect(s.a.pendingLevel).toBe(1); // the control-path slot did move
  });

  it("expires a send that outlived the TTL (no permanent phantom charge)", () => {
    const s = noteLevelSend(adopted(1), "a", 3, T).state;
    expect(unconfirmedLevels(s, "a", T + UNCONFIRMED_SEND_TTL_MS - 1_000)).toEqual([3]);
    expect(unconfirmedLevels(s, "a", T + UNCONFIRMED_SEND_TTL_MS)).toEqual([]);
  });

  it("the TTL outlasts the worst observed confirm lag (≥15.8 min)", () => {
    expect(UNCONFIRMED_SEND_TTL_MS).toBeGreaterThan(16 * 60_000);
  });

  it("excludes a level marked firmware-unreachable", () => {
    let s = adopted(1);
    for (let i = 0; i < UNREACHABLE_LEVEL_SENDS; i++) s = noteLevelSend(s, "a", 3, T + i * 60_000).state;
    expect(unconfirmedLevels(s, "a", T + 4 * 60_000)).toEqual([]);
  });

  it("power-off and a manual probe clear it — a SOURCE CHANGE does not", () => {
    const sent = noteLevelSend(adopted(1), "a", 3, T).state;
    expect(unconfirmedLevels(clearOnPowerOff(sent, "a"), "a", T + 1_000)).toEqual([]);
    expect(unconfirmedLevels(clearMarksOnManual(sent, "a"), "a", T + 1_000)).toEqual([]);
    // A changeover used to wipe these, which erased the only memory of a level
    // already travelling to the firmware — and the firmware RESTORES its last
    // commanded level after a power cycle, so that send is exactly the worst
    // case the envelope and the FLOORS clamp should still be charging for.
    // Live 2026-08-03 00:13Z: an L3 sent two minutes before a grid→gen
    // changeover went unclamped for 27 minutes and unpriced the whole time.
    expect(unconfirmedLevels(clearOnSourceChange(sent), "a", T + 1_000)).toEqual([3]);
    // …and it still expires on its own clock.
    expect(unconfirmedLevels(clearOnSourceChange(sent), "a", T + UNCONFIRMED_SEND_TTL_MS)).toEqual([]);
  });

  it("a preserved send landing late is OUR command, not a manual change", () => {
    // After a changeover the pending slot is gone, so the late confirm used to
    // fall through to the manual-intent branch — and manual wins over every
    // automatic decision until a human clears it.
    const sent = clearOnSourceChange(noteLevelSend(adopted(1), "a", 3, T).state);
    const adopt = observeLevel(sent, "a", 1, opts); // firmware reports the old level first
    expect(adopt.result.kind).toBe("adopted");
    const late = observeLevel(adopt.state, "a", 3, opts);
    expect(late.result.kind).toBe("landed");
    // …and the envelope stops charging for it once it has landed.
    expect(unconfirmedLevels(late.state, "a", T + 1_000)).toEqual([]);
  });

  it("is empty for an unknown device", () => {
    expect(unconfirmedLevels(initialReconcilerState(), "nobody", T)).toEqual([]);
  });
});
