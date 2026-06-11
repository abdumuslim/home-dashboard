import { describe, it, expect, vi } from "vitest";
import { TclCloud, latestReportedAtMs, deviceOnline, SHADOW_STALE_MS, CONTROL_VERIFY_MAX_RESENDS, type AcDevice, type AcAction } from "./tcl-cloud.js";

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
    model: "TAC-12CHSD", // non-Najat unless overridden — protocol forks key on this, NOT maxGeneratorLevel
    maxGeneratorLevel: 3,
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
    const tcl = tclWithDevice(acDevice({ model: "TAC-24CHSA", fanSpeed: 4 }));
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

// Regression tests for the 2026-06 TCL gen-level removal: stored profiles and
// presets may still carry levels above the device max (Najat's old 4–6). The
// firmware ACCEPTS such commands but never applies them, so an unclamped diff
// would re-send the same value every 5s forever.
describe("generator-mode clamp (levels above device max)", () => {
  it("clamps a stored profile's generator_mode to the device max in the payload", () => {
    const tcl = tclWithDevice(acDevice({ model: "TAC-24CHSA" }));
    const payload = buildPayload(tcl, "ac1", { generator_mode: 6 });
    expect(payload).toEqual({ generatorMode: 3 });
  });

  it("passes generator_mode 0 (auto/unrestricted) through unchanged", () => {
    const tcl = tclWithDevice(acDevice({}));
    const payload = buildPayload(tcl, "ac1", { generator_mode: 0 });
    expect(payload).toEqual({ generatorMode: 0 });
  });

  it("computeAcDiff goes quiet when the device already sits at the clamped level", () => {
    // Device reports L3; a stale preset wants L6 → clamped to 3 → no diff →
    // no 5s re-enforcement loop.
    const tcl = tclWithDevice(acDevice({ model: "TAC-24CHSA", generatorMode: 3 }));
    const diff = tcl.computeAcDiff("ac1", { generator_mode: 6 });
    expect(diff).toBeNull();
  });

  it("computeAcDiff still raises to the clamped level when below it", () => {
    const tcl = tclWithDevice(acDevice({ generatorMode: 1 }));
    const diff = tcl.computeAcDiff("ac1", { generator_mode: 6 });
    expect(diff).toEqual({ generator_mode: 3 });
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

// UI command verify-resend (2026-06-11): Najat's firmware routinely accepts a
// command without applying it — the shadow keeps the pre-command value. After
// a UI send, the shadow is re-checked every 5s and the command re-published up
// to 3 times; an observed THIRD value (a genuine remote change) stops the loop.
describe("sendControlVerified (5s × 3 confirm-or-resend)", () => {
  type Shadow = { reported: Record<string, number>; reportedAt: number | null };

  function verifiableTcl(dev: AcDevice, shadows: Array<Record<string, number>>): {
    tcl: TclCloud;
    sendControl: ReturnType<typeof vi.fn>;
    publishWithRetry: ReturnType<typeof vi.fn>;
    getThingShadow: ReturnType<typeof vi.fn>;
    awaitVerify: () => Promise<void>;
  } {
    const tcl = tclWithDevice(dev);
    const seam = tcl as unknown as {
      sendControl: unknown;
      publishWithRetry: unknown;
      getThingShadow: unknown;
      controlVerifyDelay: unknown;
      lastControlVerify: Promise<void> | null;
    };
    const sendControl = vi.fn(async () => undefined);
    const publishWithRetry = vi.fn(async () => undefined);
    const queue: Shadow[] = shadows.map((reported) => ({ reported, reportedAt: null }));
    const getThingShadow = vi.fn(async () => queue.length > 1 ? queue.shift()! : queue[0]);
    seam.sendControl = sendControl;
    seam.publishWithRetry = publishWithRetry;
    seam.getThingShadow = getThingShadow;
    seam.controlVerifyDelay = vi.fn(async () => undefined); // no real 5s waits in tests
    return { tcl, sendControl, publishWithRetry, getThingShadow, awaitVerify: async () => { await seam.lastControlVerify; } };
  }

  const najat = () => acDevice({ name: "Najat", model: "TAC-24CHSA" });

  it("re-sends while the shadow still shows the pre-command value, then stops on apply", async () => {
    const { tcl, publishWithRetry, awaitVerify } = verifiableTcl(najat(), [
      { windSpeed7Gear: 3 }, // pre-command capture
      { windSpeed7Gear: 3 }, // +5s: still pre → re-send 1
      { windSpeed7Gear: 5 }, // +10s: applied → stop
    ]);
    await tcl.sendControlVerified("ac1", "set_fan_speed", 5);
    await awaitVerify();
    expect(publishWithRetry).toHaveBeenCalledTimes(1);
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { windSpeed7Gear: 5 });
  });

  it("gives up after the bounded re-sends when the firmware never applies", async () => {
    const { tcl, publishWithRetry, awaitVerify } = verifiableTcl(najat(), [
      { windSpeed7Gear: 3 }, // never moves
    ]);
    await tcl.sendControlVerified("ac1", "set_fan_speed", 5);
    await awaitVerify();
    expect(publishWithRetry).toHaveBeenCalledTimes(CONTROL_VERIFY_MAX_RESENDS);
  });

  it("stops without re-sending when the shadow moves to a third value (external change wins)", async () => {
    const { tcl, publishWithRetry, awaitVerify } = verifiableTcl(najat(), [
      { windSpeed7Gear: 3 }, // pre-command capture
      { windSpeed7Gear: 7 }, // neither pre (3) nor commanded (5) → remote change
    ]);
    await tcl.sendControlVerified("ac1", "set_fan_speed", 5);
    await awaitVerify();
    expect(publishWithRetry).not.toHaveBeenCalled();
  });

  it("verifies the silence/turbo/windSpeed triple for a non-Najat fan command", async () => {
    const { tcl, publishWithRetry, awaitVerify } = verifiableTcl(acDevice({}), [
      { windSpeed: 4, silenceSwitch: 0, turbo: 0 }, // pre
      { windSpeed: 4, silenceSwitch: 0, turbo: 0 }, // still pre → re-send 1
      { windSpeed: 0, silenceSwitch: 1, turbo: 0 }, // fan 1 applied → stop
    ]);
    await tcl.sendControlVerified("ac1", "set_fan_speed", 1);
    await awaitVerify();
    expect(publishWithRetry).toHaveBeenCalledTimes(1);
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { windSpeed: 0, silenceSwitch: 1, turbo: 0 });
  });

  it("never schedules a verify for set_generator_mode (the leveler owns its retries)", async () => {
    const { tcl, sendControl, publishWithRetry, getThingShadow } = verifiableTcl(najat(), [
      { generatorMode: 2 },
    ]);
    await tcl.sendControlVerified("ac1", "set_generator_mode", 4);
    expect(sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 4);
    expect(getThingShadow).not.toHaveBeenCalled();
    expect(publishWithRetry).not.toHaveBeenCalled();
  });

  it("never schedules a verify for fan Auto (control returns to the automation)", async () => {
    const { tcl, getThingShadow } = verifiableTcl(acDevice({}), [{ windSpeed: 4 }]);
    await tcl.sendControlVerified("ac1", "set_fan_speed", 0);
    expect(getThingShadow).not.toHaveBeenCalled();
  });
});
