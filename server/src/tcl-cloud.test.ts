import { describe, it, expect, vi } from "vitest";
import { TclCloud, latestReportedAtMs, deviceOnline, SHADOW_STALE_MS, CONTROL_VERIFY_MAX_RESENDS, type AcDevice, type AcAction } from "./tcl-cloud.js";
import { deriveAcCapabilities } from "./ac-capabilities.js";

// Regression tests for the fan/turbo coupling on non-Najat models (TAC-12CHSD):
// fan_speed 7 IS turbo:1/windSpeed:0 and fan_speed 1 IS silenceSwitch:1, so a
// desired profile carrying both fan_speed and an explicit turbo flag is
// self-contradictory — enforcing both alternated {turbo:0}/{fan_speed:7}
// commands every tick (the Abdu AC 5-second beep loop, 2026-06-08).

function acDevice(overrides: Partial<AcDevice>): AcDevice {
  const model = overrides.model ?? "TAC-12CHSD";
  const id = overrides.id ?? "ac1";
  return {
    id,
    name: "Abdu AC",
    displayName: "Abdu",
    displayOrder: 2,
    levelingEligible: true,
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
    model, // non-Najat unless overridden — protocol forks key on this, NOT maxGeneratorLevel
    maxGeneratorLevel: 3,
    tempStep: 1,
    minFanSpeed: 1,
    maxFanSpeed: 7,
    beep: false,
    capabilities: deriveAcCapabilities(id, model, {
      powerSwitch: 1,
      workMode: 1,
      temperature: 25,
      windSpeed: 3,
      silenceSwitch: 0,
      turbo: 0,
      ECO: 0,
      screen: 1,
      sleep: 0,
      verticalSwitch: 0,
      horizontalSwitch: 0,
      verticalWind: 0,
      horizontalWind: 0,
      generatorMode: 1,
      beepSwitch: 0,
    }),
    ...overrides,
  };
}

describe("capability-aware TCL commands", () => {
  it("publishes an advanced multi-property command through the normal retry path", async () => {
    const device = acDevice({
      id: "DlXqDBFAAAE",
      maxGeneratorLevel: 6,
      capabilities: deriveAcCapabilities("DlXqDBFAAAE", "TAC-12CHSD", {
        powerSwitch: 1,
        workMode: 1,
        generatorMode: 6,
        AIECOSwitch: 0,
      }),
    });
    const tcl = tclWithDevice(device);
    const seam = tcl as unknown as {
      ensureValidTokens: () => Promise<void>;
      publishShadowUpdate: (deviceId: string, payload: Record<string, unknown>) => Promise<void>;
    };
    seam.ensureValidTokens = vi.fn(async () => undefined);
    seam.publishShadowUpdate = vi.fn(async () => undefined);

    await tcl.sendControl("DlXqDBFAAAE", "set_ai_eco", 1);

    expect(seam.publishShadowUpdate).toHaveBeenCalledWith("DlXqDBFAAAE", { eightAddHot: 0, AIECOSwitch: 1 });
  });

  it("validates generator levels against the cached physical device", () => {
    const guest = acDevice({
      id: "DlXqDBFAAAE",
      maxGeneratorLevel: 6,
      capabilities: deriveAcCapabilities("DlXqDBFAAAE", "TAC-12CHSD", { powerSwitch: 0, generatorMode: 0 }),
    });
    const tcl = tclWithDevice(guest);

    expect(tcl.validateControl("DlXqDBFAAAE", "set_generator_mode", 6)).toEqual({ ok: true });
    expect(tcl.validateControl("missing", "set_generator_mode", 1)).toEqual({
      ok: false,
      status: 404,
      error: "Unknown AC device: missing",
    });
  });

  it("refreshes mode-dependent availability before validating a sequential control", async () => {
    const stale = acDevice({
      mode: 3,
      capabilities: deriveAcCapabilities("ac1", "TAC-12CHSD", {
        powerSwitch: 1, workMode: 3, windSpeed: 3, ECO: 0,
      }),
    });
    const tcl = tclWithDevice(stale);
    const seam = tcl as unknown as {
      ensureValidTokens: () => Promise<void>;
      getThingShadow: (deviceId: string) => Promise<{ reported: Record<string, number>; reportedAt: number | null }>;
    };
    seam.ensureValidTokens = vi.fn(async () => undefined);
    seam.getThingShadow = vi.fn(async () => ({
      reported: { powerSwitch: 1, workMode: 1, windSpeed: 3, ECO: 0 },
      reportedAt: null,
    }));

    await expect(tcl.validateControlLive("ac1", "set_eco", 1)).resolves.toEqual({ ok: true });
    expect(seam.getThingShadow).toHaveBeenCalledWith("ac1");
  });
});

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
    expect(sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 4, false, true);
    expect(getThingShadow).not.toHaveBeenCalled();
    expect(publishWithRetry).not.toHaveBeenCalled();
  });

  it("never schedules a verify for fan Auto (control returns to the automation)", async () => {
    const { tcl, getThingShadow } = verifiableTcl(acDevice({}), [{ windSpeed: 4 }]);
    await tcl.sendControlVerified("ac1", "set_fan_speed", 0);
    expect(getThingShadow).not.toHaveBeenCalled();
  });
});

// Last-write-wins verifier (2026-08-08 05:55): power is a BINARY field, so the
// third-value escape can never fire for it — the only value other than the
// commanded one IS the pre-command value. Two overlapping set_power verify
// loops (a fast OFF then ON, 3s apart) each read the other's landed value as
// "my command not applied" and re-sent — off→on→off→on, 3 re-sends each over
// 24s, physically cycling Najat's compressor. A per-(device, command)
// generation makes the older loop yield to the newer verified send.
describe("sendControlVerified last-write-wins (binary set_power)", () => {
  type Shadow = { reported: Record<string, number>; reportedAt: number | null };

  // Queue shadow — for the single ordered scenario where the ON verifier must
  // visibly re-send then confirm while the superseded OFF stays quiet.
  function queueTcl(dev: AcDevice, shadows: Array<Record<string, number>>): {
    tcl: TclCloud;
    publishWithRetry: ReturnType<typeof vi.fn>;
    getThingShadow: ReturnType<typeof vi.fn>;
  } {
    const tcl = tclWithDevice(dev);
    const seam = tcl as unknown as {
      sendControl: unknown; publishWithRetry: unknown; getThingShadow: unknown; controlVerifyDelay: unknown;
    };
    const publishWithRetry = vi.fn(async () => undefined);
    const queue: Shadow[] = shadows.map((reported) => ({ reported, reportedAt: null }));
    const getThingShadow = vi.fn(async () => queue.length > 1 ? queue.shift()! : queue[0]);
    seam.sendControl = vi.fn(async () => undefined);
    seam.publishWithRetry = publishWithRetry;
    seam.getThingShadow = getThingShadow;
    seam.controlVerifyDelay = vi.fn(async () => undefined);
    return { tcl, publishWithRetry, getThingShadow };
  }

  // Fixed per-device shadow — for isolation cases where both loops must run to
  // completion regardless of interleaving (the shadow never matches the command,
  // so each un-superseded loop re-sends its full 3 times and gives up).
  function fixedTcl(devices: AcDevice[], shadowFor: (id: string) => Record<string, number>): {
    tcl: TclCloud;
    publishWithRetry: ReturnType<typeof vi.fn>;
  } {
    const tcl = new TclCloud("user", "pass");
    (tcl as unknown as { cachedDevices: AcDevice[] }).cachedDevices = devices;
    const seam = tcl as unknown as {
      sendControl: unknown; publishWithRetry: unknown; getThingShadow: unknown; controlVerifyDelay: unknown;
    };
    const publishWithRetry = vi.fn(async () => undefined);
    seam.sendControl = vi.fn(async () => undefined);
    seam.publishWithRetry = publishWithRetry;
    seam.getThingShadow = vi.fn(async (id: string) => ({ reported: shadowFor(id), reportedAt: null }));
    seam.controlVerifyDelay = vi.fn(async () => undefined);
    return { tcl, publishWithRetry };
  }

  // The verify loops are pure microtasks (mocked delays/shadow/publish), so one
  // macrotask hop drains every pending re-send.
  const drain = () => new Promise((r) => setTimeout(r, 0));

  it("stops the older set_power verify when a newer one supersedes it (off then on)", async () => {
    const { tcl, publishWithRetry } = queueTcl(acDevice({}), [
      { powerSwitch: 1 }, // OFF pre-command capture (device on)
      { powerSwitch: 0 }, // ON pre-command capture (device now off)
      { powerSwitch: 0 }, // ON verify #1: still off → re-send on
      { powerSwitch: 1 }, // ON verify #2: on applied → confirm
    ]);
    // Called synchronously: the ON bumps the generation before the OFF's verify
    // loop runs its first tick, so the OFF is superseded with zero re-sends —
    // exactly the 3s-apart production ordering (ON lands before the 5s tick).
    const off = tcl.sendControlVerified("ac1", "set_power", 0);
    const on = tcl.sendControlVerified("ac1", "set_power", 1);
    await off;
    await on;
    await drain();

    expect(publishWithRetry).toHaveBeenCalledTimes(1);
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { powerSwitch: 1 });     // ON proceeds normally
    expect(publishWithRetry).not.toHaveBeenCalledWith("ac1", { powerSwitch: 0 }); // OFF yields, never fights
  });

  it("a lone set_power verify still re-sends up to 3 times when the shadow never applies", async () => {
    // No second command → the generation never moves → behavior is unchanged.
    const { tcl, publishWithRetry } = queueTcl(acDevice({}), [
      { powerSwitch: 1 }, // never reaches the commanded 0
    ]);
    await tcl.sendControlVerified("ac1", "set_power", 0);
    await (tcl as unknown as { lastControlVerify: Promise<void> }).lastControlVerify;

    expect(publishWithRetry).toHaveBeenCalledTimes(CONTROL_VERIFY_MAX_RESENDS);
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { powerSwitch: 0 });
  });

  it("supersession is per device — a set_power on ac2 does not cancel ac1's verify", async () => {
    const { tcl, publishWithRetry } = fixedTcl(
      [acDevice({ id: "ac1" }), acDevice({ id: "ac2" })],
      (id) => (id === "ac1" ? { powerSwitch: 1 } : { powerSwitch: 0 }),
    );
    const a = tcl.sendControlVerified("ac1", "set_power", 0); // wants 0, shadow stuck at 1
    const b = tcl.sendControlVerified("ac2", "set_power", 1); // wants 1, shadow stuck at 0
    await a;
    await b;
    await drain();

    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { powerSwitch: 0 }); // ac1 not superseded by ac2
    expect(publishWithRetry).toHaveBeenCalledWith("ac2", { powerSwitch: 1 });
  });

  it("supersession is per command — a set_temperature does not cancel a set_power verify", async () => {
    const { tcl, publishWithRetry } = fixedTcl(
      [acDevice({ id: "ac1" })],
      () => ({ powerSwitch: 1, targetTemperature: 22 }),
    );
    const p = tcl.sendControlVerified("ac1", "set_power", 0);        // wants powerSwitch 0
    const t = tcl.sendControlVerified("ac1", "set_temperature", 24); // wants targetTemperature 24
    await p;
    await t;
    await drain();

    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { powerSwitch: 0 });        // set_power verify still ran
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { targetTemperature: 24 }); // set_temperature verify ran
  });
});

// The TAC-12CHSD "shadow says yes but device says no" quirk: when fan props
// share a shadow update with ANY other property, the firmware applies the other
// property, internally resets the blower, and still reports the fan as applied.
// computeAcDiff then sees no diff and never retries — the fan stays low forever
// while the dashboard reads max.
//
// Discovered 2026-05-10 with workMode; the guard was written for that one pair.
// 2026-07-27 proved it is not workMode-specific: after a gen→grid changeover
// rebooted Abdu AC, the re-enforcement published
//   {windSpeed:0, silenceSwitch:0, turbo:1, verticalSwitch:0, verticalDirection:10,
//    horizontalSwitch:0, horizontalDirection:11}
// (fan + swings, NO workMode) and the blower never went to turbo. 13 minutes
// later the identical fan block sent ALONE applied on the first try.
describe("executeAcAction fan isolation (TAC-12CHSD)", () => {
  function publishingTcl(dev: AcDevice): { tcl: TclCloud; publishWithRetry: ReturnType<typeof vi.fn> } {
    const tcl = tclWithDevice(dev);
    const seam = tcl as unknown as { publishWithRetry: unknown; profileSplitDelay: unknown };
    const publishWithRetry = vi.fn(async () => undefined);
    seam.publishWithRetry = publishWithRetry;
    seam.profileSplitDelay = vi.fn(async () => undefined); // no real 500ms waits in tests
    return { tcl, publishWithRetry };
  }

  const FAN_7 = { windSpeed: 0, silenceSwitch: 0, turbo: 1 };

  it("splits the fan out of a swing payload (2026-07-27 post-changeover regression)", async () => {
    const { tcl, publishWithRetry } = publishingTcl(acDevice({}));
    await tcl.executeAcAction("ac1", { fan_speed: 7, vertical_swing: 10, horizontal_swing: 11 });
    expect(publishWithRetry).toHaveBeenCalledTimes(2);
    expect(publishWithRetry).toHaveBeenNthCalledWith(1, "ac1", {
      verticalSwitch: 0, verticalDirection: 10, horizontalSwitch: 0, horizontalDirection: 11,
    });
    expect(publishWithRetry).toHaveBeenNthCalledWith(2, "ac1", FAN_7);
  });

  it("still splits the fan out of a workMode payload (the 2026-05-10 case)", async () => {
    const { tcl, publishWithRetry } = publishingTcl(acDevice({}));
    await tcl.executeAcAction("ac1", { mode: 1, temperature: 25, fan_speed: 7 });
    expect(publishWithRetry).toHaveBeenCalledTimes(2);
    expect(publishWithRetry).toHaveBeenNthCalledWith(1, "ac1", { workMode: 1, targetTemperature: 25 });
    expect(publishWithRetry).toHaveBeenNthCalledWith(2, "ac1", FAN_7);
  });

  it("splits the fan out of a generator-level payload too", async () => {
    const { tcl, publishWithRetry } = publishingTcl(acDevice({}));
    await tcl.executeAcAction("ac1", { fan_speed: 7, generator_mode: 3 });
    expect(publishWithRetry).toHaveBeenCalledTimes(2);
    expect(publishWithRetry).toHaveBeenNthCalledWith(1, "ac1", { generatorMode: 3 });
    expect(publishWithRetry).toHaveBeenNthCalledWith(2, "ac1", FAN_7);
  });

  it("publishes once when the payload is fan-only (nothing to conflict with)", async () => {
    const { tcl, publishWithRetry } = publishingTcl(acDevice({}));
    await tcl.executeAcAction("ac1", { fan_speed: 7 });
    expect(publishWithRetry).toHaveBeenCalledTimes(1);
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", FAN_7);
  });

  it("publishes once when the payload carries no fan at all", async () => {
    const { tcl, publishWithRetry } = publishingTcl(acDevice({}));
    await tcl.executeAcAction("ac1", { mode: 1, temperature: 25 });
    expect(publishWithRetry).toHaveBeenCalledTimes(1);
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { workMode: 1, targetTemperature: 25 });
  });

  it("applies Fan→Cool plus Eco as one mode-aware profile", async () => {
    const device = acDevice({
      mode: 3,
      capabilities: deriveAcCapabilities("ac1", "TAC-12CHSD", {
        powerSwitch: 1,
        workMode: 3,
        windSpeed: 3,
        ECO: 0,
      }),
    });
    const { tcl, publishWithRetry } = publishingTcl(device);

    await tcl.executeAcAction("ac1", { mode: 1, eco: 1 });

    expect(publishWithRetry).toHaveBeenCalledTimes(1);
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { workMode: 1, ECO: 1 });
  });

  it("re-sends an ignored verified profile with the same main/fan split", async () => {
    const device = acDevice({
      mode: 3,
      fanSpeed: 3,
      capabilities: deriveAcCapabilities("ac1", "TAC-12CHSD", {
        powerSwitch: 1,
        workMode: 3,
        windSpeed: 3,
        silenceSwitch: 0,
        turbo: 0,
        ECO: 0,
      }),
    });
    const { tcl, publishWithRetry } = publishingTcl(device);
    const seam = tcl as unknown as {
      getThingShadow: unknown;
      controlVerifyDelay: unknown;
    };
    seam.controlVerifyDelay = vi.fn(async () => undefined);
    seam.getThingShadow = vi.fn()
      .mockResolvedValueOnce({ reported: { workMode: 3, ECO: 0, windSpeed: 3, silenceSwitch: 0, turbo: 0 }, reportedAt: null })
      .mockResolvedValueOnce({ reported: { workMode: 3, ECO: 0, windSpeed: 3, silenceSwitch: 0, turbo: 0 }, reportedAt: null })
      .mockResolvedValueOnce({ reported: { workMode: 1, ECO: 1, windSpeed: 0, silenceSwitch: 0, turbo: 1 }, reportedAt: null });

    await tcl.executeAcActionVerified("ac1", { mode: 1, eco: 1, fan_speed: 7 });

    expect(publishWithRetry).toHaveBeenCalledTimes(4);
    expect(publishWithRetry).toHaveBeenNthCalledWith(1, "ac1", { workMode: 1, ECO: 1 });
    expect(publishWithRetry).toHaveBeenNthCalledWith(2, "ac1", FAN_7);
    expect(publishWithRetry).toHaveBeenNthCalledWith(3, "ac1", { workMode: 1, ECO: 1 });
    expect(publishWithRetry).toHaveBeenNthCalledWith(4, "ac1", FAN_7);
  });

  it("lets a newer direct command supersede an in-flight preset verifier", async () => {
    const { tcl, publishWithRetry } = publishingTcl(acDevice({ mode: 3 }));
    const delayResolvers: Array<() => void> = [];
    const seam = tcl as unknown as {
      getThingShadow: unknown;
      controlVerifyDelay: unknown;
      sendControl: unknown;
    };
    seam.getThingShadow = vi.fn(async () => ({ reported: { workMode: 3 }, reportedAt: null }));
    seam.controlVerifyDelay = vi.fn(() => new Promise<void>((resolve) => delayResolvers.push(resolve)));
    seam.sendControl = vi.fn(async () => undefined);

    const preset = tcl.executeAcActionVerified("ac1", { mode: 1 });
    while (delayResolvers.length < 1) await Promise.resolve();
    await tcl.sendControlVerified("ac1", "set_mode", 4);
    delayResolvers[0]();

    await expect(preset).resolves.toBe("superseded");
    expect(publishWithRetry).toHaveBeenCalledTimes(1);
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { workMode: 1 });
  });

  it("keeps stale automation enforcement behind an in-flight manual preset", async () => {
    const { tcl, publishWithRetry } = publishingTcl(acDevice({ mode: 3 }));
    const delayResolvers: Array<() => void> = [];
    const seam = tcl as unknown as {
      getThingShadow: unknown;
      controlVerifyDelay: unknown;
    };
    seam.getThingShadow = vi.fn()
      .mockResolvedValueOnce({ reported: { workMode: 3 }, reportedAt: null })
      .mockResolvedValueOnce({ reported: { workMode: 1 }, reportedAt: null });
    seam.controlVerifyDelay = vi.fn(() => new Promise<void>((resolve) => delayResolvers.push(resolve)));

    const preset = tcl.executeAcActionVerified("ac1", { mode: 1 });
    while (delayResolvers.length < 1) await Promise.resolve();

    // The collector may still hold the old automation profile until the route
    // persists/reloads the successful preset. That background enforcement must
    // neither cancel the manual intent nor publish the stale mode over it.
    const staleAutomation = await tcl.executeAcAction(
      "ac1",
      { mode: 3 },
      { suppressWhileManualPresetPending: true },
    );
    expect(staleAutomation).toBe("suppressed");
    expect(publishWithRetry).toHaveBeenCalledTimes(1);

    delayResolvers[0]();
    await expect(preset).resolves.toBe("applied");
    expect(publishWithRetry).toHaveBeenCalledTimes(1);
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { workMode: 1 });
  });

  it("lets an authoritative background action supersede a pending manual preset", async () => {
    const { tcl, publishWithRetry } = publishingTcl(acDevice({ mode: 3 }));
    const delayResolvers: Array<() => void> = [];
    const seam = tcl as unknown as {
      getThingShadow: unknown;
      controlVerifyDelay: unknown;
    };
    seam.getThingShadow = vi.fn(async () => ({ reported: { workMode: 3 }, reportedAt: null }));
    seam.controlVerifyDelay = vi.fn(() => new Promise<void>((resolve) => delayResolvers.push(resolve)));

    const preset = tcl.executeAcActionVerified("ac1", { mode: 1 });
    while (delayResolvers.length < 1) await Promise.resolve();

    const safetyAction = await tcl.executeAcAction("ac1", { mode: 4 });
    expect(safetyAction).toBe("applied");
    expect(publishWithRetry).toHaveBeenLastCalledWith("ac1", { workMode: 4 });

    delayResolvers[0]();
    await expect(preset).resolves.toBe("superseded");
  });

  it("lets a raw leveler control cancel a pending preset before it can retry", async () => {
    const { tcl } = publishingTcl(acDevice({ mode: 3 }));
    const delayResolvers: Array<() => void> = [];
    const seam = tcl as unknown as {
      getThingShadow: unknown;
      controlVerifyDelay: unknown;
      publishShadowUpdate: unknown;
      ensureValidTokens: unknown;
    };
    seam.getThingShadow = vi.fn(async () => ({ reported: { workMode: 3 }, reportedAt: null }));
    seam.controlVerifyDelay = vi.fn(() => new Promise<void>((resolve) => delayResolvers.push(resolve)));
    seam.publishShadowUpdate = vi.fn(async () => undefined);
    seam.ensureValidTokens = vi.fn(async () => undefined);

    const preset = tcl.executeAcActionVerified("ac1", { mode: 1 });
    while (delayResolvers.length < 1) await Promise.resolve();
    await tcl.sendControl("ac1", "set_generator_mode", 1);

    delayResolvers[0]();
    await expect(preset).resolves.toBe("superseded");
  });

  it("fails closed when profile execution cannot resolve the physical device", async () => {
    const tcl = new TclCloud("user", "pass");
    const seam = tcl as unknown as {
      ensureDeviceCachePopulated: unknown;
      publishWithRetry: unknown;
    };
    const publishWithRetry = vi.fn(async () => undefined);
    seam.ensureDeviceCachePopulated = vi.fn(async () => undefined);
    seam.publishWithRetry = publishWithRetry;

    await expect(tcl.executeAcAction("missing", { mode: 1, temperature: 22, eco: 1 }))
      .rejects.toThrow("Unknown AC device: missing");
    expect(publishWithRetry).not.toHaveBeenCalled();
  });

  it("leaves Najat bundled — her fan key is unaffected by this quirk", async () => {
    const { tcl, publishWithRetry } = publishingTcl(acDevice({ name: "Najat", model: "TAC-24CHSA" }));
    await tcl.executeAcAction("ac1", { fan_speed: 5, vertical_swing: 9 });
    expect(publishWithRetry).toHaveBeenCalledTimes(1);
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { windSpeed7Gear: 5, verticalWind: 0, verticalDirection: 9 });
  });
});

// The saved last-state set always carries workMode next to the fan block, so
// the same quirk cost the fan on EVERY manual power-on of a TAC-12CHSD.
describe("restoreLastState fan isolation (TAC-12CHSD)", () => {
  function restorableTcl(dev: AcDevice, saved: Record<string, unknown>): {
    tcl: TclCloud;
    publishShadowUpdate: ReturnType<typeof vi.fn>;
    restore: () => Promise<void>;
  } {
    const tcl = tclWithDevice(dev);
    const seam = tcl as unknown as {
      lastState: Record<string, Record<string, unknown>>;
      publishShadowUpdate: unknown;
      profileSplitDelay: unknown;
      restoreLastState: (deviceId: string) => Promise<void>;
    };
    const publishShadowUpdate = vi.fn(async () => undefined);
    seam.lastState = { ac1: saved };
    seam.publishShadowUpdate = publishShadowUpdate;
    seam.profileSplitDelay = vi.fn(async () => undefined);
    return { tcl, publishShadowUpdate, restore: () => seam.restoreLastState.call(tcl, "ac1") };
  }

  it("restores the fan block as its own update", async () => {
    const { publishShadowUpdate, restore } = restorableTcl(acDevice({}), {
      workMode: 1, targetTemperature: 25, windSpeed: 0, silenceSwitch: 0, turbo: 1, generatorMode: 3,
    });
    await restore();
    expect(publishShadowUpdate).toHaveBeenCalledTimes(2);
    expect(publishShadowUpdate).toHaveBeenNthCalledWith(1, "ac1", { workMode: 1, targetTemperature: 25, generatorMode: 3 });
    expect(publishShadowUpdate).toHaveBeenNthCalledWith(2, "ac1", { windSpeed: 0, silenceSwitch: 0, turbo: 1 });
  });

  it("still clamps a saved generator level above the device max", async () => {
    const { publishShadowUpdate, restore } = restorableTcl(acDevice({}), {
      workMode: 1, turbo: 1, generatorMode: 6,
    });
    await restore();
    expect(publishShadowUpdate).toHaveBeenNthCalledWith(1, "ac1", { workMode: 1, generatorMode: 3 });
  });

  it("restores verified advanced settings but not one-shot maintenance actions", async () => {
    const { publishShadowUpdate, restore } = restorableTcl(acDevice({}), {
      workMode: 1,
      AIECOSwitch: 1,
      softWind: 1,
      healthy: 1,
      antiMoldew: 1,
      lightSense: 1,
      beepSwitch: 0,
      eightAddHot: 0,
      selfClean: 1,
    });
    await restore();
    expect(publishShadowUpdate).toHaveBeenCalledTimes(1);
    expect(publishShadowUpdate).toHaveBeenCalledWith("ac1", {
      workMode: 1,
      AIECOSwitch: 1,
      softWind: 1,
      healthy: 1,
      antiMoldew: 1,
      lightSense: 1,
      beepSwitch: 0,
      eightAddHot: 0,
    });
  });

  it("restores Najat in a single update", async () => {
    const { publishShadowUpdate, restore } = restorableTcl(acDevice({ name: "Najat", model: "TAC-24CHSA" }), {
      workMode: 1, targetTemperature: 22, windSpeed7Gear: 5,
    });
    await restore();
    expect(publishShadowUpdate).toHaveBeenCalledTimes(1);
    expect(publishShadowUpdate).toHaveBeenCalledWith("ac1", { workMode: 1, targetTemperature: 22, windSpeed7Gear: 5 });
  });
});
