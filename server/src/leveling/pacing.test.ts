import { describe, it, expect } from "vitest";
import {
  ATTEMPT_BLAME_WINDOW_MS,
  attemptedRecently,
  backoffDelayMs,
  barPersistMs,
  BOUNCE_BACKOFF_MAX_MS,
  bounceBackoffMs,
  canAttempt,
  clearBounces,
  initialPacingState,
  noteAttempt,
  noteFailure,
  noteSuccess,
  resetPacing,
  reshedPenalized,
  restoreBounces,
} from "./pacing.js";

const T = 1_000_000;

describe("hybrid backoff ladder", () => {
  it("grows 30s → 2m → 5m → 15m and caps at 15m", () => {
    expect(backoffDelayMs(1)).toBe(30_000);
    expect(backoffDelayMs(2)).toBe(120_000);
    expect(backoffDelayMs(3)).toBe(300_000);
    expect(backoffDelayMs(4)).toBe(900_000);
    expect(backoffDelayMs(9)).toBe(900_000); // capped — no permanent strand
  });

  it("failures gate attempts until the cooldown passes; success resets the ladder", () => {
    let s = initialPacingState("gen");
    expect(canAttempt(s, "a", "raise", T)).toBe(true);
    s = noteFailure(s, "a", "raise", T);
    expect(canAttempt(s, "a", "raise", T + 29_000)).toBe(false);
    expect(canAttempt(s, "a", "raise", T + 30_000)).toBe(true);
    s = noteFailure(s, "a", "raise", T + 40_000);
    expect(canAttempt(s, "a", "raise", T + 40_000 + 119_000)).toBe(false);
    s = noteSuccess(s, "a", "raise");
    expect(canAttempt(s, "a", "raise", T + 41_000)).toBe(true);
    s = noteFailure(s, "a", "raise", T + 50_000);
    expect(canAttempt(s, "a", "raise", T + 50_000 + 30_000)).toBe(true); // ladder restarted
  });

  it("kinds and devices are independent", () => {
    let s = noteFailure(initialPacingState("gen"), "a", "raise", T);
    expect(canAttempt(s, "a", "restore", T)).toBe(true);
    expect(canAttempt(s, "b", "raise", T)).toBe(true);
  });
});

describe("blame window & re-shed penalty", () => {
  it("attemptedRecently tracks the blame window", () => {
    const s = noteAttempt(initialPacingState("gen"), "a", "raise", T);
    expect(attemptedRecently(s, "a", "raise", T + ATTEMPT_BLAME_WINDOW_MS)).toBe(true);
    expect(attemptedRecently(s, "a", "raise", T + ATTEMPT_BLAME_WINDOW_MS + 1)).toBe(false);
  });

  it("reshedPenalized only while a restore failure's cooldown is live", () => {
    let s = noteFailure(initialPacingState("gen"), "a", "restore", T);
    expect(reshedPenalized(s, "a", T + 1_000)).toBe(true);
    expect(reshedPenalized(s, "a", T + 31_000)).toBe(false); // cooldown passed
    expect(reshedPenalized(noteSuccess(s, "a", "restore"), "a", T + 1_000)).toBe(false);
  });
});

describe("source change", () => {
  it("resets the whole ladder (per-source physics)", () => {
    let s = noteFailure(initialPacingState("gen"), "a", "raise", T);
    s = resetPacing(s, "grid");
    expect(canAttempt(s, "a", "raise", T)).toBe(true);
    expect(s.source).toBe("grid");
  });
});

// 2026-08-07 14:08–14:31Z: Najat shed five times in 23 min. The re-sheds landed
// 52–69 s after each restore (inside the blame window), so `failures` climbed
// 1→4 — but its early rungs (30/120/300 s) are ≤ the 300 s shed-trough bar, so
// the BAR stayed the binding clock: it refused each restore correctly, then
// expired and the trough was re-spent. A consecutive-bounce COUNT compounds that
// bar's persistence past the plateau.
describe("restore bounce backoff (2026-08-07 limit cycle)", () => {
  it("bounceBackoffMs doubles the ~5-min plateau per bounce and hard-caps at 30 min", () => {
    expect(bounceBackoffMs(1)).toBe(600_000); // 10 min
    expect(bounceBackoffMs(2)).toBe(1_200_000); // 20 min
    expect(bounceBackoffMs(3)).toBe(BOUNCE_BACKOFF_MAX_MS); // 2400s → capped 1800s
    expect(bounceBackoffMs(9)).toBe(BOUNCE_BACKOFF_MAX_MS); // no unbounded strand
  });

  it("each restore bounce compounds the shed-trough wait far past the ladder's own rung", () => {
    // The wait that actually holds a bouncing room is its shed-trough BAR
    // (invariant 54), which now persists for the compounded backoff. The ADMISSION
    // ladder is left on its ordinary rungs so invariant 22's re-arm still works
    // for a genuine (bar-released) drop — see the raise-side test.
    let s = initialPacingState("gen");
    s = noteFailure(s, "najat", "restore", T); // bounce 1
    expect(restoreBounces(s, "najat")).toBe(1);
    expect(barPersistMs(s, "najat")).toBe(600_000); // past the old 300 s bar
    expect(canAttempt(s, "najat", "restore", T + 30_000)).toBe(true); // ladder unmoved
    s = noteFailure(s, "najat", "restore", T + 600_000); // bounce 2
    expect(restoreBounces(s, "najat")).toBe(2);
    expect(barPersistMs(s, "najat")).toBe(1_200_000);
  });

  it("keeps invariant 22 fully intact when the bounce count is 0", () => {
    // No bounce this session → the bar keeps its plain blame window and the
    // admission ladder is untouched; nothing here compounds.
    const s = initialPacingState("gen");
    expect(restoreBounces(s, "najat")).toBe(0);
    expect(barPersistMs(s, "najat")).toBe(ATTEMPT_BLAME_WINDOW_MS);
    expect(canAttempt(s, "najat", "restore", T)).toBe(true);
  });

  it("a restore that STICKS (survives its blame window) resets the bounce count", () => {
    let s = noteFailure(initialPacingState("gen"), "najat", "restore", T);
    s = noteFailure(s, "najat", "restore", T + 600_000);
    expect(restoreBounces(s, "najat")).toBe(2);
    // noteSuccess is the "it stuck" signal (fired by the grade window past the
    // blame window). It clears the count AND the compounded bar persistence.
    s = noteSuccess(s, "najat", "restore");
    expect(restoreBounces(s, "najat")).toBe(0);
    expect(barPersistMs(s, "najat")).toBe(ATTEMPT_BLAME_WINDOW_MS);
  });

  it("a RAISE failure does not book a bounce (bounces are restore-side)", () => {
    let s = noteFailure(initialPacingState("gen"), "abdu", "raise", T);
    expect(restoreBounces(s, "abdu")).toBe(0);
    expect(barPersistMs(s, "abdu")).toBe(ATTEMPT_BLAME_WINDOW_MS);
    // …and the raise ladder keeps its ordinary first rung, uncompounded.
    expect(canAttempt(s, "abdu", "raise", T + 30_000)).toBe(true);
  });

  it("only a genuine power_off shed books a bounce — a set_level cut is a failure, not a bounce", () => {
    let s = initialPacingState("gen");
    // A level cut of a recently restored room: a ladder failure, but NOT a shed
    // bounce, so it must not compound the trough bar.
    s = noteFailure(s, "najat", "restore", T, false);
    expect(restoreBounces(s, "najat")).toBe(0);
    expect(canAttempt(s, "najat", "restore", T + 29_000)).toBe(false); // ladder DID arm
    expect(barPersistMs(s, "najat")).toBe(ATTEMPT_BLAME_WINDOW_MS); // bar NOT compounded
    // A real re-shed does book one.
    s = noteFailure(s, "najat", "restore", T + 1_000, true);
    expect(restoreBounces(s, "najat")).toBe(1);
    expect(barPersistMs(s, "najat")).toBe(600_000);
  });

  it("clearBounces ends the bounce episode (external ON) without moving the ladder", () => {
    let s = noteFailure(initialPacingState("gen"), "najat", "restore", T, true);
    s = noteFailure(s, "najat", "restore", T + 600_000, true);
    expect(restoreBounces(s, "najat")).toBe(2);
    expect(barPersistMs(s, "najat")).toBe(1_200_000);
    s = clearBounces(s, "najat");
    // A future UNRELATED shed's bar persists the ordinary 300 s, not 1200 s.
    expect(restoreBounces(s, "najat")).toBe(0);
    expect(barPersistMs(s, "najat")).toBe(ATTEMPT_BLAME_WINDOW_MS);
    // …but the ladder cooldown is untouched — it expires on its own.
    expect(canAttempt(s, "najat", "restore", T + 600_000 + 119_000)).toBe(false);
    expect(canAttempt(s, "najat", "restore", T + 600_000 + 120_000)).toBe(true);
  });

  it("a source change wipes the bounce count (per-line physics re-decides)", () => {
    let s = noteFailure(initialPacingState("gen"), "najat", "restore", T);
    s = noteFailure(s, "najat", "restore", T + 600_000);
    s = resetPacing(s, "gen");
    expect(restoreBounces(s, "najat")).toBe(0);
    expect(barPersistMs(s, "najat")).toBe(ATTEMPT_BLAME_WINDOW_MS);
  });
});
