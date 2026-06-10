import { describe, it, expect } from "vitest";
import { TclCloud, latestReportedAtMs, deviceOnline, SHADOW_STALE_MS, type AcDevice, type AcAction } from "./tcl-cloud.js";

// Regression tests for the fan/turbo coupling on non-Najat models (TAC-12CHSD):
// fan_speed 7 IS turbo:1/windSpeed:0 and fan_speed 1 IS silenceSwitch:1, so a
// desired profile carrying both fan_speed and an explicit turbo flag is
// self-contradictory — enforcing both alternated {turbo:0}/{fan_speed:7}
// commands every tick (the Abdu AC 5-second beep loop, 2026-06-08).

function acDevice(overrides: Partial<AcDevice>): AcDevice {
  return {
    id: "ac1",
    name: "Abdu AC",
    isOnline: true,
    lastSeenAt: null,
    power: true,
    mode: 1,
    targetTemp: 25,
    currentTemp: 27,
    fanSpeed: 3,
    eco: false,
    sleep: 0,
    screen: true,
    verticalSwing: 0,
    horizontalSwing: 0,
    turbo: false,
    freshAir: false,
    hasFreshAir: false,
    generatorMode: 1,
    maxGeneratorLevel: 3, // non-Najat unless overridden to 6
    tempStep: 1,
    minFanSpeed: 1,
    maxFanSpeed: 7,
    beep: false,
    ...overrides,
  };
}

function tclWithDevice(dev: AcDevice): TclCloud {
  const tcl = new TclCloud("user", "pass");
  (tcl as unknown as { cachedDevices: AcDevice[] }).cachedDevices = [dev];
  return tcl;
}

function buildPayload(tcl: TclCloud, deviceId: string, action: AcAction): Record<string, unknown> {
  return (tcl as unknown as {
    buildProfileShadowPayload: (deviceId: string, action: AcAction) => Record<string, unknown>;
  }).buildProfileShadowPayload(deviceId, action);
}

describe("computeAcDiff fan/turbo coupling (non-Najat)", () => {
  it("converges to null when device is at fan 7 (turbo on) and profile wants fan 7 + turbo 0", () => {
    // The beep-loop regression: turbo:1 on the device is HOW fan 7 is
    // implemented — it must not diff against the profile's turbo:0.
    const tcl = tclWithDevice(acDevice({ fanSpeed: 7, turbo: true }));
    const diff = tcl.computeAcDiff("ac1", { mode: 1, temperature: 25, fan_speed: 7, turbo: 0 });
    expect(diff).toBeNull();
  });

  it("diffs only fan_speed (never turbo) from the mid-oscillation state", () => {
    // After a stray set_turbo 0 the device sits at windSpeed 0 → derived fan 0
    const tcl = tclWithDevice(acDevice({ fanSpeed: 0, turbo: false }));
    const diff = tcl.computeAcDiff("ac1", { mode: 1, temperature: 25, fan_speed: 7, turbo: 0 });
    expect(diff).toEqual({ fan_speed: 7 });
  });

  it("lets fan_speed win over a contradictory turbo:1 in the profile", () => {
    const tcl = tclWithDevice(acDevice({ fanSpeed: 7, turbo: true }));
    const diff = tcl.computeAcDiff("ac1", { mode: 1, temperature: 25, fan_speed: 3, turbo: 1 });
    expect(diff).toEqual({ fan_speed: 3 });
  });

  it("still enforces a turbo-only profile (no fan_speed present)", () => {
    const tcl = tclWithDevice(acDevice({ fanSpeed: 3, turbo: false }));
    const diff = tcl.computeAcDiff("ac1", { mode: 1, temperature: 25, turbo: 1 });
    expect(diff).toEqual({ turbo: 1 });
  });

  it("keeps plain fan_speed diffs working on Najat", () => {
    const tcl = tclWithDevice(acDevice({ maxGeneratorLevel: 6, fanSpeed: 4 }));
    const diff = tcl.computeAcDiff("ac1", { mode: 1, temperature: 25, fan_speed: 5, turbo: 0 });
    expect(diff).toEqual({ fan_speed: 5 });
  });
});

describe("buildProfileShadowPayload fan/turbo coupling (non-Najat)", () => {
  it("does not let an explicit turbo:1 override the fan block for fan 2-6", () => {
    const tcl = tclWithDevice(acDevice({}));
    const payload = buildPayload(tcl, "ac1", { fan_speed: 5, turbo: 1 });
    expect(payload).toEqual({ windSpeed: 5, silenceSwitch: 0, turbo: 0 });
  });

  it("keeps turbo:1 from the fan block when fan is 7", () => {
    const tcl = tclWithDevice(acDevice({}));
    const payload = buildPayload(tcl, "ac1", { fan_speed: 7, turbo: 0 });
    expect(payload).toEqual({ windSpeed: 0, silenceSwitch: 0, turbo: 1 });
  });

  it("still sends a turbo-only payload when no fan_speed is given", () => {
    const tcl = tclWithDevice(acDevice({}));
    const payload = buildPayload(tcl, "ac1", { turbo: 1 });
    expect(payload).toEqual({ turbo: 1 });
  });
});

describe("shadow freshness → online flag (blackout detection)", () => {
  it("latestReportedAtMs takes the newest per-field timestamp and converts seconds→ms", () => {
    expect(latestReportedAtMs({
      powerSwitch: { timestamp: 1000 },
      currentTemperature: { timestamp: 1500 },
      workMode: { timestamp: 1200 },
    })).toBe(1500 * 1000);
  });

  it("latestReportedAtMs returns null when metadata is missing or empty", () => {
    expect(latestReportedAtMs(undefined)).toBeNull();
    expect(latestReportedAtMs({})).toBeNull();
    expect(latestReportedAtMs({ x: {} })).toBeNull();
  });

  it("trusts TCL's online flag regardless of shadow freshness", () => {
    const stale = Date.now() - SHADOW_STALE_MS - 60_000;
    expect(deviceOnline(true, true, stale, Date.now(), SHADOW_STALE_MS)).toBe(true);
  });

  it("marks a blacked-out AC offline: TCL offline + a stale (persisted) shadow", () => {
    const now = 10_000_000;
    const stale = now - SHADOW_STALE_MS - 1;
    expect(deviceOnline(false, true, stale, now, SHADOW_STALE_MS)).toBe(false);
  });

  it("keeps a live AC online: TCL offline but the shadow reported recently", () => {
    const now = 10_000_000;
    const fresh = now - 30_000;
    expect(deviceOnline(false, true, fresh, now, SHADOW_STALE_MS)).toBe(true);
  });

  it("falls back to legacy has-shadow behavior when no freshness metadata exists", () => {
    const now = 10_000_000;
    expect(deviceOnline(false, true, null, now, SHADOW_STALE_MS)).toBe(true);
    expect(deviceOnline(false, false, null, now, SHADOW_STALE_MS)).toBe(false);
  });
});
