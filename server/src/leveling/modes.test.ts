import { describe, it, expect } from "vitest";
import {
  FAN_SETTLE_MS,
  FLOORS_MAX_MS,
  SETTLE_MS,
  applyMeterEvent,
  clearFloorsIfDone,
  clearFloorsOnManual,
  deriveMode,
  initialModeState,
  noteBatch,
} from "./modes.js";

const T = 1_000_000;

describe("mode derivation & priority", () => {
  it("starts NORMAL", () => {
    expect(deriveMode(initialModeState(), T)).toBe("NORMAL");
  });

  it("entering gen arms FLOORS — including from a cold start (none→gen)", () => {
    const fromGrid = applyMeterEvent(initialModeState(), { kind: "source_changed", from: "grid", to: "gen" }, T);
    expect(deriveMode(fromGrid, T)).toBe("FLOORS");
    const coldStart = applyMeterEvent(initialModeState(), { kind: "source_changed", from: "none", to: "gen" }, T);
    expect(deriveMode(coldStart, T)).toBe("FLOORS");
  });

  it("entering grid does NOT arm FLOORS and clears a live one", () => {
    let s = applyMeterEvent(initialModeState(), { kind: "source_changed", from: "grid", to: "gen" }, T);
    s = applyMeterEvent(s, { kind: "source_changed", from: "gen", to: "grid" }, T + 1_000);
    expect(deriveMode(s, T + 1_000)).toBe("NORMAL");
  });

  it("COLLAPSED overrides FLOORS; recovery falls back to the still-live FLOORS window", () => {
    let s = applyMeterEvent(initialModeState(), { kind: "source_changed", from: "grid", to: "gen" }, T);
    s = applyMeterEvent(s, { kind: "collapse", fromAmps: 13, toAmps: 4, source: "gen" }, T + 5_000);
    expect(deriveMode(s, T + 5_000)).toBe("COLLAPSED");
    s = applyMeterEvent(s, { kind: "collapse_recovered", source: "gen" }, T + 60_000);
    expect(deriveMode(s, T + 60_000)).toBe("FLOORS");
  });

  it("FLOORS expires via the backstop", () => {
    const s = applyMeterEvent(initialModeState(), { kind: "source_changed", from: "grid", to: "gen" }, T);
    expect(deriveMode(s, T + FLOORS_MAX_MS - 1)).toBe("FLOORS");
    expect(deriveMode(s, T + FLOORS_MAX_MS)).toBe("NORMAL");
  });
});

describe("settle windows", () => {
  it("level/power batches open the full settle window; fan-only the short one", () => {
    const level = noteBatch(initialModeState(), { fanOnly: false }, T);
    expect(deriveMode(level, T + SETTLE_MS - 1)).toBe("SETTLING");
    expect(deriveMode(level, T + SETTLE_MS)).toBe("NORMAL");
    const fan = noteBatch(initialModeState(), { fanOnly: true }, T);
    expect(deriveMode(fan, T + FAN_SETTLE_MS - 1)).toBe("SETTLING");
    expect(deriveMode(fan, T + FAN_SETTLE_MS)).toBe("NORMAL");
  });

  it("a shorter batch never shortens a longer live window", () => {
    let s = noteBatch(initialModeState(), { fanOnly: false }, T);
    s = noteBatch(s, { fanOnly: true }, T + 1_000);
    expect(deriveMode(s, T + SETTLE_MS - 1)).toBe("SETTLING");
  });

  it("a source change clears the settle window", () => {
    let s = noteBatch(initialModeState(), { fanOnly: false }, T);
    s = applyMeterEvent(s, { kind: "source_changed", from: "gen", to: "grid" }, T + 1_000);
    expect(deriveMode(s, T + 1_000)).toBe("NORMAL");
  });
});

describe("FLOORS exit", () => {
  const floors = () =>
    applyMeterEvent(initialModeState(), { kind: "source_changed", from: "grid", to: "gen" }, T);

  it("clears only when every shadow confirmed floor AND no compressor is ramping", () => {
    expect(deriveMode(clearFloorsIfDone(floors(), { allConfirmedAtFloor: true, anyRamping: true }), T)).toBe("FLOORS");
    expect(deriveMode(clearFloorsIfDone(floors(), { allConfirmedAtFloor: false, anyRamping: false }), T)).toBe("FLOORS");
    expect(deriveMode(clearFloorsIfDone(floors(), { allConfirmedAtFloor: true, anyRamping: false }), T)).toBe("NORMAL");
  });

  it("a manual gen change clears FLOORS (manual wins)", () => {
    expect(deriveMode(clearFloorsOnManual(floors()), T)).toBe("NORMAL");
  });
});
