import { describe, it, expect } from "vitest";
import {
  ATTEMPT_BLAME_WINDOW_MS,
  attemptedRecently,
  backoffDelayMs,
  canAttempt,
  initialPacingState,
  noteAttempt,
  noteFailure,
  noteSuccess,
  resetPacing,
  reshedPenalized,
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
