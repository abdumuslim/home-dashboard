import { describe, it, expect, vi } from "vitest";
import {
  TclCloud,
  latestReportedAtMs,
  deviceOnline,
  isolatedPowerOffAfter,
  powerReportInfo,
  ISOLATED_POWER_REPORT_MAX_COHORT,
  FULL_STATE_MIN_FIELDS,
  SHADOW_STALE_MS,
  CONTROL_VERIFY_MAX_RESENDS,
  AcProfileNotAppliedError,
  isPowerAcceptedError,
  type AcDevice,
  type AcAction,
} from "./tcl-cloud.js";
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

// Remote off must stick (2026-09-27). The raw shadow probe of all four units
// showed that a power OFF stamps `powerSwitch` ALONE in `metadata.reported`,
// while a power ON (and every reconnect / power-loss restart) dumps ~45-55
// fields with one timestamp. AWS stamps on ARRIVAL, so only ORDER on the unit's
// own connection is causal: our ON's dump first, then the lone OFF. Fixtures are
// shaped like the probe captures.
describe("shadow power-report metadata (causal: ON dump, then isolated OFF)", () => {
  const SEND_SEC = 1_790_522_500; // our power-ON publish, epoch seconds
  const sendMs = SEND_SEC * 1000 + 400; // mid-second, as a real send lands

  /** A full-state dump like Najat 15:21:59-15:22:00: `n` fields over two seconds. */
  function fullStateMeta(sec: number, n: number, prefix = "field"): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) meta[`${prefix}${i}`] = { timestamp: i % 2 === 0 ? sec : sec + 1 };
    return meta;
  }

  /** Our ON's dump at `dumpSec`, then powerSwitch re-stamped alone at `powerSec`. */
  function dumpThenOff(dumpSec: number, powerSec: number): Record<string, unknown> {
    return {
      ...fullStateMeta(dumpSec, 50),
      windSpeed7Gear: { timestamp: dumpSec + 30 },
      capabilities: [{ timestamp: dumpSec }, { timestamp: dumpSec }],
      errorCode: [],
      powerSwitch: { timestamp: powerSec },
    };
  }

  it("powerReportInfo: a lone powerSwitch after a dump: cohort 1, dump start recorded", () => {
    expect(powerReportInfo(dumpThenOff(SEND_SEC + 2, SEND_SEC + 20))).toEqual({
      powerReportedAt: (SEND_SEC + 20) * 1000,
      powerReportCohort: 1,
      fullStateReportAt: (SEND_SEC + 2) * 1000,
    });
  });

  it("powerReportInfo: powerSwitch inside a full-state dump counts the whole cluster", () => {
    const meta = { ...fullStateMeta(SEND_SEC + 5, 52), powerSwitch: { timestamp: SEND_SEC + 5 } };
    expect(powerReportInfo(meta)).toEqual({
      powerReportedAt: (SEND_SEC + 5) * 1000,
      powerReportCohort: 53,
      fullStateReportAt: (SEND_SEC + 5) * 1000,
    });
  });

  it("powerReportInfo: the NEWEST dump wins, an incremental burst is not a dump", () => {
    const meta = {
      ...fullStateMeta(SEND_SEC - 300, 50, "old"),
      ...fullStateMeta(SEND_SEC + 3, 30, "new"),
      burstA: { timestamp: SEND_SEC + 40 },
      burstB: { timestamp: SEND_SEC + 40 },
      burstC: { timestamp: SEND_SEC + 41 },
      powerSwitch: { timestamp: SEND_SEC + 60 },
    };
    expect(powerReportInfo(meta).fullStateReportAt).toBe((SEND_SEC + 3) * 1000);
    expect(powerReportInfo(fullStateMeta(SEND_SEC, 10)).fullStateReportAt).toBeNull(); // no powerSwitch at all
    const noDump = { ...fullStateMeta(SEND_SEC, FULL_STATE_MIN_FIELDS - 1), powerSwitch: { timestamp: SEND_SEC + 20 } };
    expect(powerReportInfo(noDump).fullStateReportAt).toBeNull();
  });

  it("powerReportInfo: no metadata, or no powerSwitch stamp, is unknown", () => {
    const unknown = { powerReportedAt: null, powerReportCohort: null, fullStateReportAt: null };
    expect(powerReportInfo(undefined)).toEqual(unknown);
    expect(powerReportInfo(fullStateMeta(SEND_SEC, 10))).toEqual(unknown);
    expect(powerReportInfo({ powerSwitch: {} })).toEqual(unknown);
  });

  it("isolatedPowerOffAfter: our ON's dump, then a lone OFF: a human off", () => {
    const info = powerReportInfo(dumpThenOff(SEND_SEC + 2, SEND_SEC + 20));
    expect(isolatedPowerOffAfter({ power: false, ...info }, sendMs)).toBe(true);
  });

  it("isolatedPowerOffAfter: a lone OFF stamped after the send with NO post-send dump is ambiguous (late delivery)", () => {
    // The dump is the shed-era one, 300 s old: nothing proves our ON landed
    // before this off, so it may be an off delivered late to AWS.
    const info = powerReportInfo(dumpThenOff(SEND_SEC - 300, SEND_SEC + 20));
    expect(isolatedPowerOffAfter({ power: false, ...info }, sendMs)).toBe(false);
  });

  it("isolatedPowerOffAfter: a stale OFF from before the send is lag (the unit never applied our ON)", () => {
    const info = powerReportInfo(dumpThenOff(SEND_SEC - 300, SEND_SEC - 200));
    expect(isolatedPowerOffAfter({ power: false, ...info }, sendMs)).toBe(false);
  });

  it("isolatedPowerOffAfter: an OFF stamped inside a full-state dump after the send is a reconnect, not a hand", () => {
    const meta = { ...fullStateMeta(SEND_SEC + 30, 45), powerSwitch: { timestamp: SEND_SEC + 30 } };
    expect(isolatedPowerOffAfter({ power: false, ...powerReportInfo(meta) }, sendMs)).toBe(false);
  });

  it("isolatedPowerOffAfter: a dump AFTER the lone off (a reconnect since) is ambiguous", () => {
    const meta = { ...fullStateMeta(SEND_SEC + 40, 45), powerSwitch: { timestamp: SEND_SEC + 20 } };
    expect(isolatedPowerOffAfter({ power: false, ...powerReportInfo(meta) }, sendMs)).toBe(false);
  });

  it("isolatedPowerOffAfter: a dump in the send's own second counts, one second earlier does not", () => {
    expect(isolatedPowerOffAfter({ power: false, ...powerReportInfo(dumpThenOff(SEND_SEC, SEND_SEC + 20)) }, sendMs)).toBe(true);
    expect(isolatedPowerOffAfter({ power: false, ...powerReportInfo(dumpThenOff(SEND_SEC - 1, SEND_SEC + 20)) }, sendMs)).toBe(false);
  });

  it("isolatedPowerOffAfter: no metadata keeps today's shadow-lag reading", () => {
    expect(isolatedPowerOffAfter({ power: false, powerReportedAt: null, powerReportCohort: null, fullStateReportAt: null }, sendMs)).toBe(false);
    expect(isolatedPowerOffAfter({ power: false }, sendMs)).toBe(false);
  });

  it("isolatedPowerOffAfter: the cohort threshold is inclusive at ISOLATED_POWER_REPORT_MAX_COHORT", () => {
    const base = { power: false, powerReportedAt: (SEND_SEC + 20) * 1000, fullStateReportAt: (SEND_SEC + 2) * 1000 };
    expect(isolatedPowerOffAfter({ ...base, powerReportCohort: ISOLATED_POWER_REPORT_MAX_COHORT }, sendMs)).toBe(true);
    expect(isolatedPowerOffAfter({ ...base, powerReportCohort: ISOLATED_POWER_REPORT_MAX_COHORT + 1 }, sendMs)).toBe(false);
  });

  it("isolatedPowerOffAfter: an ON is never an off, and no send time means no claim", () => {
    const info = powerReportInfo(dumpThenOff(SEND_SEC + 2, SEND_SEC + 20));
    expect(isolatedPowerOffAfter({ power: true, ...info }, sendMs)).toBe(false);
    expect(isolatedPowerOffAfter({ power: false, ...info }, 0)).toBe(false);
  });

  it("getThingShadow + fetchDevices carry the power-report fields onto the AcDevice", async () => {
    const tcl = new TclCloud("user", "pass");
    const seam = tcl as unknown as {
      tokenData: unknown;
      authData: unknown;
      awsCreds: unknown;
      signAwsRequest: () => Record<string, string>;
      fetchDevices: () => Promise<AcDevice[]>;
    };
    seam.tokenData = { saasToken: "t", cognitoToken: "c", cognitoId: "i", mqttEndpoint: "m" };
    seam.authData = { token: "a", refreshToken: "r", username: "u", countryAbbr: "IQ" };
    seam.awsCreds = { accessKeyId: "k", secretKey: "s", sessionToken: "x", expiration: Date.now() + 3_600_000, region: "eu-central-1" };
    seam.signAwsRequest = () => ({});
    const shadowDoc = {
      state: { reported: { powerSwitch: 0, workMode: 1, autoGeneratorMode: 0, beepSwitch: 0 } },
      metadata: { reported: dumpThenOff(SEND_SEC + 2, SEND_SEC + 20) },
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("user_groups/get")) {
        return new Response(JSON.stringify({ code: 0, data: [{ devices: [{ deviceId: "DHihohFAAAE", nickName: "Najat", isOnline: "1" }] }] }));
      }
      return new Response(JSON.stringify(shadowDoc));
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const [dev] = await seam.fetchDevices();
      expect(dev.power).toBe(false);
      expect(dev.powerReportedAt).toBe((SEND_SEC + 20) * 1000);
      expect(dev.powerReportCohort).toBe(1);
      expect(dev.fullStateReportAt).toBe((SEND_SEC + 2) * 1000);
      expect(isolatedPowerOffAfter(dev, sendMs)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// Cross-layer fight (2026-09-26 14:26Z double-shed forensics): the user's
// dashboard ON started a set_power=1 verify loop; the leveler shed the room
// ~2 s later through executeAcAction({power:0}); the ON verifier then read the
// landed OFF as "not applied" and re-sent ON at 14:26:43.8. A leveler (or any
// other raw) power command is newer intent and must supersede the verifier.
describe("a raw power command supersedes a pending set_power verifier", () => {
  it("leveler power_off while the user's ON verifier waits: the verifier never re-sends ON", async () => {
    const tcl = tclWithDevice(acDevice({ name: "Najat", model: "TAC-24CHSA" }));
    let releaseDelay: () => void = () => undefined;
    const seam = tcl as unknown as {
      sendControl: unknown; publishWithRetry: unknown; getThingShadow: unknown; controlVerifyDelay: unknown;
      ensureDeviceCachePopulated: unknown; lastControlVerify: Promise<void> | null;
    };
    const publishWithRetry = vi.fn(async () => undefined);
    const shadows = [{ powerSwitch: 0 }, { powerSwitch: 0 }]; // pre, then the leveler's OFF landed
    seam.sendControl = vi.fn(async () => undefined);
    seam.publishWithRetry = publishWithRetry;
    seam.getThingShadow = vi.fn(async () => ({ reported: shadows.length > 1 ? shadows.shift()! : shadows[0], reportedAt: null }));
    seam.ensureDeviceCachePopulated = vi.fn(async () => undefined);
    let held = false;
    // Hold ONLY the first verify delay (the leveler's off lands inside it); later ones pass straight through.
    seam.controlVerifyDelay = vi.fn(() => {
      if (held) return Promise.resolve();
      held = true;
      return new Promise<void>((resolve) => { releaseDelay = resolve; });
    });

    await tcl.sendControlVerified("ac1", "set_power", 1); // the user's ON; verifier now waiting
    await tcl.executeAcAction("ac1", { power: 0 });       // the leveler sheds the room
    releaseDelay();
    await seam.lastControlVerify;

    expect(publishWithRetry.mock.calls.filter((c: unknown[]) => c[0] === "ac1").map((c: unknown[]) => c[1])).not.toContainEqual({ powerSwitch: 1 });
  });

  it("the newer OFF lands WHILE the verifier's shadow read is in flight: still no ON republish", async () => {
    // The generation check used to run only BEFORE the read, so an OFF arriving
    // during the read slipped past it (Sol recheck, 2026-09-27).
    const tcl = tclWithDevice(acDevice({ name: "Najat", model: "TAC-24CHSA" }));
    const seam = tcl as unknown as {
      sendControl: unknown; publishWithRetry: unknown; getThingShadow: unknown; controlVerifyDelay: unknown;
      ensureDeviceCachePopulated: unknown; lastControlVerify: Promise<void> | null;
    };
    const publishWithRetry = vi.fn(async () => undefined);
    let releaseRead: () => void = () => undefined;
    let reads = 0;
    seam.getThingShadow = vi.fn(() => {
      reads++;
      const shadow = { reported: { powerSwitch: 0 }, reportedAt: null };
      if (reads !== 2) return Promise.resolve(shadow); // 1 = pre-capture, 3+ = later rounds
      return new Promise((resolve) => { releaseRead = () => resolve(shadow); }); // the verifier's first read
    });
    seam.sendControl = vi.fn(async () => undefined);
    seam.publishWithRetry = publishWithRetry;
    seam.ensureDeviceCachePopulated = vi.fn(async () => undefined);
    seam.controlVerifyDelay = vi.fn(async () => undefined);

    await tcl.sendControlVerified("ac1", "set_power", 1); // the user's ON
    await vi.waitFor(() => expect(reads).toBe(2));         // verifier is now inside its shadow read
    await tcl.executeAcAction("ac1", { power: 0 });        // the leveler sheds the room
    releaseRead();                                          // the read returns the landed OFF
    await seam.lastControlVerify;

    expect(publishWithRetry.mock.calls.filter((c: unknown[]) => c[0] === "ac1").map((c: unknown[]) => c[1])).not.toContainEqual({ powerSwitch: 1 });
  });
});

// Round 4 (Sol, 2026-09-27): ONE generation check at the publish boundary. Node
// is single-threaded, so a check with no await between it and the publish call
// is the only place where "newer command already claimed this field" cannot
// change before the send starts. Checks at earlier awaits kept missing the next
// await (the pre-state read, then the token refresh).
describe("the dashboard power command is checked AT the publish boundary", () => {
  function realSendTcl() {
    const tcl = tclWithDevice(acDevice({ name: "Najat", model: "TAC-24CHSA" }));
    const seam = tcl as unknown as {
      ensureValidTokens: unknown; publishShadowUpdate: unknown; getThingShadow: unknown; controlVerifyDelay: unknown;
      ensureDeviceCachePopulated: unknown; restoreLastState: unknown; publishWithRetry: unknown;
      lastControlVerify: Promise<void> | null;
    };
    const published: Array<Record<string, unknown>> = [];
    seam.publishShadowUpdate = vi.fn(async (_id: string, desired: Record<string, unknown>) => { published.push(desired); });
    seam.publishWithRetry = vi.fn(async (_id: string, desired: Record<string, unknown>) => { published.push(desired); });
    seam.getThingShadow = vi.fn(async () => ({ reported: { powerSwitch: 0 }, reportedAt: null }));
    seam.ensureDeviceCachePopulated = vi.fn(async () => undefined);
    seam.restoreLastState = vi.fn(async () => undefined);
    seam.controlVerifyDelay = vi.fn(async () => undefined);
    return { tcl, seam, published };
  }

  it("the leveler OFF publishes while the dashboard ON waits for its token refresh: the ON is never published and reports superseded", async () => {
    const { tcl, seam, published } = realSendTcl();
    let releaseTokens: () => void = () => undefined;
    let tokenCalls = 0;
    seam.ensureValidTokens = vi.fn(() => {
      tokenCalls++;
      if (tokenCalls !== 1) return Promise.resolve();
      return new Promise<void>((resolve) => { releaseTokens = resolve; }); // the dashboard ON's token wait
    });

    const dashboardOn = tcl.sendControlVerified("ac1", "set_power", 1);
    await vi.waitFor(() => expect(tokenCalls).toBe(1)); // the ON is inside sendControl, waiting for tokens
    await tcl.executeAcAction("ac1", { power: 0 });      // the leveler's OFF publishes first
    releaseTokens();
    const outcome = await dashboardOn;
    await seam.lastControlVerify;

    expect(published).toEqual([{ powerSwitch: 0 }]); // only the OFF ever reached the cloud
    expect(outcome).toBe("superseded");
  });

  it("an ordinary dashboard command reports sent", async () => {
    const { tcl, seam } = realSendTcl();
    seam.ensureValidTokens = vi.fn(async () => undefined);
    expect(await tcl.sendControlVerified("ac1", "set_power", 1)).toBe("sent");
  });

  it("manual wins: a leveler restore ON never supersedes the user's pending OFF verifier", async () => {
    // Only a protective OFF supersedes a dashboard power command. A restore ON
    // landing while the user's OFF is being verified must not silence that
    // verifier: the user's off (already locked) has to stick.
    const { tcl, seam, published } = realSendTcl();
    seam.ensureValidTokens = vi.fn(async () => undefined);
    const shadows = [{ powerSwitch: 1 }, { powerSwitch: 1 }]; // pre (on), then the restore's ON landed
    seam.getThingShadow = vi.fn(async () => ({ reported: shadows.length > 1 ? shadows.shift()! : shadows[0], reportedAt: null }));
    let releaseDelay: () => void = () => undefined;
    let held = false;
    seam.controlVerifyDelay = vi.fn(() => {
      if (held) return Promise.resolve();
      held = true;
      return new Promise<void>((resolve) => { releaseDelay = resolve; });
    });

    await tcl.sendControlVerified("ac1", "set_power", 0); // the user's OFF
    await tcl.executeAcAction("ac1", { power: 1 });                            // a restore ON races it
    releaseDelay();
    await seam.lastControlVerify;

    expect(published.filter((p) => p.powerSwitch === 0).length, "the user's OFF is re-sent over the restore").toBeGreaterThanOrEqual(2);
  });
});

// Round 5 (Sol, 2026-09-27), the two rules that close item 8 for every await:
// RULE A every publish a dashboard command can make (the initial one, the
// saved-state restore after an ON, every verifier resend) goes through the
// guarded same-tick publish; RULE B the outcome reflects the FINAL generation,
// so a command superseded after its own publish still reports superseded.
describe("dashboard power command: every publish guarded, outcome reflects the final generation", () => {
  function realTcl() {
    const tcl = tclWithDevice(acDevice({ name: "Najat", model: "TAC-24CHSA" }));
    const seam = tcl as unknown as {
      ensureValidTokens: unknown; publishShadowUpdate: unknown; getThingShadow: unknown; controlVerifyDelay: unknown;
      ensureDeviceCachePopulated: unknown; restoreLastState: unknown; lastState: Record<string, Record<string, unknown>>;
      lastControlVerify: Promise<void> | null;
    };
    const published: Array<Record<string, unknown>> = [];
    seam.publishShadowUpdate = vi.fn(async (_id: string, desired: Record<string, unknown>) => { published.push(desired); });
    seam.getThingShadow = vi.fn(async () => ({ reported: { powerSwitch: 0 }, reportedAt: null }));
    seam.ensureDeviceCachePopulated = vi.fn(async () => undefined);
    seam.controlVerifyDelay = vi.fn(async () => undefined);
    seam.ensureValidTokens = vi.fn(async () => undefined);
    return { tcl, seam, published };
  }

  it("RULE A: the leveler OFF lands while a verifier RESEND waits for its token refresh: the stale ON is never republished", async () => {
    const { tcl, seam, published } = realTcl();
    seam.restoreLastState = vi.fn(async () => undefined);
    let releaseTokens: () => void = () => undefined;
    let tokenCalls = 0;
    seam.ensureValidTokens = vi.fn(() => {
      tokenCalls++;
      if (tokenCalls !== 2) return Promise.resolve();                         // 1 = initial send
      return new Promise<void>((resolve) => { releaseTokens = resolve; });     // 2 = the resend's token wait
    });

    expect(await tcl.sendControlVerified("ac1", "set_power", 1)).toBe("sent");
    await vi.waitFor(() => expect(tokenCalls).toBe(2)); // the verifier found OFF and is re-sending
    await tcl.executeAcAction("ac1", { power: 0 });     // the leveler sheds the room
    releaseTokens();
    await seam.lastControlVerify;

    expect(published).toEqual([{ powerSwitch: 1 }, { powerSwitch: 0 }]); // the initial ON, the shed; no stale resend
  });

  it("RULE B: the leveler OFF lands while the ON's saved-state restore waits: outcome superseded, no restore published", async () => {
    vi.useFakeTimers();
    try {
      const { tcl, seam, published } = realTcl();
      seam.lastState = { ac1: { targetTemperature: 23, workMode: 1 } }; // what restoreLastState would re-publish
      const outcome = tcl.sendControlVerified("ac1", "set_power", 1);
      await vi.waitFor(() => expect(published).toEqual([{ powerSwitch: 1 }])); // the ON went out; restore now waits 1 s
      await tcl.executeAcAction("ac1", { power: 0 });                           // the leveler sheds the room
      await vi.advanceTimersByTimeAsync(1_500);

      expect(await outcome).toBe("superseded");
      expect(published).toEqual([{ powerSwitch: 1 }, { powerSwitch: 0 }]); // no saved-state restore after the shed
      await seam.lastControlVerify;
      expect(published).toEqual([{ powerSwitch: 1 }, { powerSwitch: 0 }]); // and no verifier resend either
    } finally {
      vi.useRealTimers();
    }
  });

  it("a user's own newer tap supersedes too, reported as superseded_by_user (not blamed on the leveler)", async () => {
    const { tcl, seam } = realTcl();
    let releaseRead: () => void = () => undefined;
    let reads = 0;
    seam.restoreLastState = vi.fn(async () => undefined);
    seam.getThingShadow = vi.fn(() => {
      reads++;
      const shadow = { reported: { powerSwitch: 0 }, reportedAt: null };
      if (reads !== 1) return Promise.resolve(shadow);
      return new Promise((resolve) => { releaseRead = () => resolve(shadow); });
    });
    const first = tcl.sendControlVerified("ac1", "set_power", 1);
    await vi.waitFor(() => expect(reads).toBe(1));
    const second = tcl.sendControlVerified("ac1", "set_power", 0); // the user taps again
    releaseRead();
    expect(await first).toBe("superseded_by_user");
    expect(await second).toBe("sent");
  });
});

describe("a raw power command during the dashboard command's INITIAL shadow read", () => {
  it("the leveler OFF lands while the dashboard ON is still reading its pre-state: the ON is never published", async () => {
    // Round 3 caught this at the read; round 4 moved the check to the publish
    // boundary, which covers this await and every other one (real sendControl).
    const tcl = tclWithDevice(acDevice({ name: "Najat", model: "TAC-24CHSA" }));
    const seam = tcl as unknown as {
      ensureValidTokens: unknown; publishShadowUpdate: unknown; publishWithRetry: unknown; getThingShadow: unknown;
      controlVerifyDelay: unknown; ensureDeviceCachePopulated: unknown; restoreLastState: unknown;
      lastControlVerify: Promise<void> | null;
    };
    const published: Array<Record<string, unknown>> = [];
    seam.publishShadowUpdate = vi.fn(async (_id: string, desired: Record<string, unknown>) => { published.push(desired); });
    seam.publishWithRetry = vi.fn(async (_id: string, desired: Record<string, unknown>) => { published.push(desired); });
    seam.ensureValidTokens = vi.fn(async () => undefined);
    seam.restoreLastState = vi.fn(async () => undefined);
    let releaseRead: () => void = () => undefined;
    let reads = 0;
    seam.getThingShadow = vi.fn(() => {
      reads++;
      const shadow = { reported: { powerSwitch: 1 }, reportedAt: null };
      if (reads !== 1) return Promise.resolve(shadow);
      return new Promise((resolve) => { releaseRead = () => resolve(shadow); }); // the INITIAL pre-state read
    });
    seam.ensureDeviceCachePopulated = vi.fn(async () => undefined);
    seam.controlVerifyDelay = vi.fn(async () => undefined);

    const dashboardOn = tcl.sendControlVerified("ac1", "set_power", 1);
    await vi.waitFor(() => expect(reads).toBe(1));  // inside the initial read
    await tcl.executeAcAction("ac1", { power: 0 });  // the leveler sheds the room
    releaseRead();
    expect(await dashboardOn).toBe("superseded");
    await seam.lastControlVerify;

    expect(published).toEqual([{ powerSwitch: 0 }]); // only the leveler's OFF went out
  });
});

// Partial success (Sol recheck, 2026-09-27): a power ON publishes powerSwitch,
// waits ~3 s, then publishes the profile. When only the profile throws, the ON
// is already on its way to the unit, and callers must be able to tell that
// apart from a refused send (they book the ON as sent).
describe("executeAcAction: power accepted, profile failed", () => {
  it("rejects with AcProfileNotAppliedError (powerAccepted) after the power publish went out", async () => {
    vi.useFakeTimers();
    try {
      const tcl = tclWithDevice(acDevice({ name: "Najat", model: "TAC-24CHSA" }));
      const seam = tcl as unknown as { publishWithRetry: unknown; ensureDeviceCachePopulated: unknown; publishAcProfile: unknown };
      const publishWithRetry = vi.fn(async () => undefined);
      seam.publishWithRetry = publishWithRetry;
      seam.ensureDeviceCachePopulated = vi.fn(async () => undefined);
      seam.publishAcProfile = vi.fn(async () => { throw new Error("GetThingShadow HTTP 503"); });

      const pending = tcl.executeAcAction("ac1", { power: 1, mode: 1, temperature: 23 });
      const settled = pending.then(() => null, (err: unknown) => err);
      await vi.advanceTimersByTimeAsync(3_000);
      const err = await settled;

      expect(publishWithRetry).toHaveBeenCalledWith("ac1", { powerSwitch: 1 });
      expect(err).toBeInstanceOf(AcProfileNotAppliedError);
      expect(isPowerAcceptedError(err)).toBe(true);
      expect(isPowerAcceptedError(new Error("refused"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refused POWER publish is still an ordinary failure", async () => {
    const tcl = tclWithDevice(acDevice({ name: "Najat", model: "TAC-24CHSA" }));
    const seam = tcl as unknown as { publishWithRetry: unknown; ensureDeviceCachePopulated: unknown };
    seam.publishWithRetry = vi.fn(async () => { throw new Error("cloud refused"); });
    seam.ensureDeviceCachePopulated = vi.fn(async () => undefined);
    const err = await tcl.executeAcAction("ac1", { power: 1, mode: 1, temperature: 23 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isPowerAcceptedError(err)).toBe(false);
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
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { windSpeed7Gear: 5 }, expect.any(Function));
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
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { windSpeed: 0, silenceSwitch: 1, turbo: 0 }, expect.any(Function));
  });

  it("never schedules a verify for set_generator_mode (the leveler owns its retries)", async () => {
    const { tcl, sendControl, publishWithRetry, getThingShadow } = verifiableTcl(najat(), [
      { generatorMode: 2 },
    ]);
    await tcl.sendControlVerified("ac1", "set_generator_mode", 4);
    // 6th argument: the publish-boundary guard (round 4, 2026-09-27).
    expect(sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 4, false, true, expect.any(Function));
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
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { powerSwitch: 1 }, expect.any(Function));     // ON proceeds normally
    expect(publishWithRetry.mock.calls.filter((c: unknown[]) => c[0] === "ac1").map((c: unknown[]) => c[1])).not.toContainEqual({ powerSwitch: 0 }); // OFF yields, never fights
  });

  it("a lone set_power verify still re-sends up to 3 times when the shadow never applies", async () => {
    // No second command → the generation never moves → behavior is unchanged.
    const { tcl, publishWithRetry } = queueTcl(acDevice({}), [
      { powerSwitch: 1 }, // never reaches the commanded 0
    ]);
    await tcl.sendControlVerified("ac1", "set_power", 0);
    await (tcl as unknown as { lastControlVerify: Promise<void> }).lastControlVerify;

    expect(publishWithRetry).toHaveBeenCalledTimes(CONTROL_VERIFY_MAX_RESENDS);
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { powerSwitch: 0 }, expect.any(Function));
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

    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { powerSwitch: 0 }, expect.any(Function)); // ac1 not superseded by ac2
    expect(publishWithRetry).toHaveBeenCalledWith("ac2", { powerSwitch: 1 }, expect.any(Function));
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

    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { powerSwitch: 0 }, expect.any(Function));        // set_power verify still ran
    expect(publishWithRetry).toHaveBeenCalledWith("ac1", { targetTemperature: 24 }, expect.any(Function)); // set_temperature verify ran
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

  it("freezes Guest's pre-event state and restores it instead of saving reboot defaults", async () => {
    const guest = acDevice({
      id: "DlXqDBFAAAE",
      name: "guest",
      displayName: "guest",
      displayOrder: 4,
      model: "TAC-24CHSA",
      levelingEligible: false,
      maxGeneratorLevel: 6,
    });
    const tcl = tclWithDevice(guest);
    const seam = tcl as unknown as {
      lastState: Record<string, Record<string, unknown>>;
      publishShadowUpdate: ReturnType<typeof vi.fn>;
      preparePowerCycleRestore: (deviceId: string) => boolean;
      saveStateProps: (deviceId: string, shadow: Record<string, number>, isChsa: boolean) => void;
      maybeRestorePowerCycleState: (
        deviceId: string,
        shadow: Record<string, number>,
        reportedAt: number | null,
        isChsa: boolean,
      ) => Promise<boolean>;
    };
    seam.lastState = {
      DlXqDBFAAAE: { workMode: 1, targetTemperature: 22, windSpeed7Gear: 5, generatorMode: 6 },
    };
    seam.publishShadowUpdate = vi.fn(async () => undefined);

    expect(seam.preparePowerCycleRestore("DlXqDBFAAAE")).toBe(true);
    seam.saveStateProps("DlXqDBFAAAE", {
      powerSwitch: 1,
      workMode: 1,
      targetTemperature: 24,
      windSpeed7Gear: 0,
      generatorMode: 0,
    }, true);
    expect(seam.lastState.DlXqDBFAAAE).toEqual({
      workMode: 1,
      targetTemperature: 22,
      windSpeed7Gear: 5,
      generatorMode: 6,
    });

    await expect(seam.maybeRestorePowerCycleState("DlXqDBFAAAE", {
      powerSwitch: 1,
      workMode: 1,
      targetTemperature: 24,
      windSpeed7Gear: 0,
      generatorMode: 0,
    }, Date.now() + 1_000, true)).resolves.toBe(true);
    expect(seam.publishShadowUpdate).toHaveBeenCalledWith("DlXqDBFAAAE", {
      workMode: 1,
      targetTemperature: 22,
      windSpeed7Gear: 5,
      generatorMode: 6,
    });
  });

  it("does not consume Guest's pending restore from a same-event stale ON shadow", async () => {
    const guest = acDevice({
      id: "DlXqDBFAAAE",
      model: "TAC-24CHSA",
      levelingEligible: false,
      maxGeneratorLevel: 6,
    });
    const tcl = tclWithDevice(guest);
    const seam = tcl as unknown as {
      lastState: Record<string, Record<string, unknown>>;
      pendingPowerCycleRestores: Map<string, { armedAt: number }>;
      publishShadowUpdate: ReturnType<typeof vi.fn>;
      preparePowerCycleRestore: (deviceId: string) => boolean;
      maybeRestorePowerCycleState: (
        deviceId: string,
        shadow: Record<string, number>,
        reportedAt: number | null,
        isChsa: boolean,
      ) => Promise<boolean>;
    };
    seam.lastState = { DlXqDBFAAAE: { workMode: 1, targetTemperature: 22, windSpeed7Gear: 5 } };
    seam.publishShadowUpdate = vi.fn(async () => undefined);
    seam.preparePowerCycleRestore("DlXqDBFAAAE");
    const armedAt = seam.pendingPowerCycleRestores.get("DlXqDBFAAAE")!.armedAt;

    await expect(seam.maybeRestorePowerCycleState("DlXqDBFAAAE", {
      powerSwitch: 1,
      workMode: 1,
      targetTemperature: 24,
      windSpeed7Gear: 0,
    }, armedAt - 500, true)).resolves.toBe(true);

    expect(seam.publishShadowUpdate).not.toHaveBeenCalled();
    expect(seam.pendingPowerCycleRestores.has("DlXqDBFAAAE")).toBe(true);
  });

  it("arms only a verified restore-eligible id, refusing the leveling line and unknown ids", () => {
    // Restore eligibility is a positive physical-wiring fact. Abdullah is on the
    // ESP-measured line (the leveler owns his generatorMode/fan across a
    // changeover) and an unknown future AC has unknown wiring — both are refused
    // even with saved state. Only guest, positively restore-eligible, arms.
    const tcl = new TclCloud("user", "pass");
    const seam = tcl as unknown as {
      lastState: Record<string, Record<string, unknown>>;
      pendingPowerCycleRestores: Map<string, unknown>;
    };
    seam.lastState = {
      Cy3aihFAAAE: { workMode: 1, targetTemperature: 22, windSpeed7Gear: 5 },
      ZZunknownAAAA: { workMode: 1, targetTemperature: 22, windSpeed7Gear: 5 },
      DlXqDBFAAAE: { workMode: 1, targetTemperature: 22, windSpeed7Gear: 5 },
    };

    expect(tcl.preparePowerCycleRestore("Cy3aihFAAAE")).toBe(false);
    expect(seam.pendingPowerCycleRestores.has("Cy3aihFAAAE")).toBe(false);

    expect(tcl.preparePowerCycleRestore("ZZunknownAAAA")).toBe(false);
    expect(seam.pendingPowerCycleRestores.has("ZZunknownAAAA")).toBe(false);

    expect(tcl.preparePowerCycleRestore("DlXqDBFAAAE")).toBe(true);
    expect(seam.pendingPowerCycleRestores.has("DlXqDBFAAAE")).toBe(true);
  });

  it("does not publish a restore a user command cancelled between capture and the send", async () => {
    const guest = acDevice({
      id: "DlXqDBFAAAE",
      model: "TAC-24CHSA",
      levelingEligible: false,
      maxGeneratorLevel: 6,
    });
    const tcl = tclWithDevice(guest);
    const seam = tcl as unknown as {
      lastState: Record<string, Record<string, unknown>>;
      pendingPowerCycleRestores: Map<string, unknown>;
      publishRestorableState: ReturnType<typeof vi.fn>;
      restorableState: (deviceId: string, saved: Record<string, unknown>) => Record<string, unknown>;
      preparePowerCycleRestore: (deviceId: string) => boolean;
      maybeRestorePowerCycleState: (
        deviceId: string,
        shadow: Record<string, number>,
        reportedAt: number | null,
        isChsa: boolean,
      ) => Promise<boolean>;
    };
    seam.lastState = { DlXqDBFAAAE: { workMode: 1, targetTemperature: 22, windSpeed7Gear: 5 } };
    const publishRestorableState = vi.fn(async () => undefined);
    seam.publishRestorableState = publishRestorableState;

    expect(seam.preparePowerCycleRestore("DlXqDBFAAAE")).toBe(true);
    const captured = seam.pendingPowerCycleRestores.get("DlXqDBFAAAE");

    // Simulate a user command deleting the pending mid-tick — after the poll has
    // captured `pending` but before the network send. The restore must not fire.
    const realRestorable = seam.restorableState.bind(tcl);
    seam.restorableState = (deviceId, saved) => {
      seam.pendingPowerCycleRestores.delete("DlXqDBFAAAE");
      return realRestorable(deviceId, saved);
    };

    await expect(seam.maybeRestorePowerCycleState("DlXqDBFAAAE", {
      powerSwitch: 1,
      workMode: 1,
      targetTemperature: 24, // mismatches the saved 22 → would otherwise publish
      windSpeed7Gear: 0,
    }, Date.now() + 1_000, true)).resolves.toBe(false);

    expect(publishRestorableState).not.toHaveBeenCalled();
    // The captured object is stale — the map no longer holds it.
    expect(seam.pendingPowerCycleRestores.get("DlXqDBFAAAE")).not.toBe(captured);
  });
});

// A pending last-state restore holds the frozen pre-event snapshot and freezes
// state-save. Any NEWER direct user intent (a control or a verified preset)
// makes that snapshot stale, so the pending must be cancelled — loudly, since a
// silent cancellation is the next forensic mystery. Background automation
// enforcement is NOT user intent and must leave the pending alone.
describe("pending last-state restore yields to newer user intent", () => {
  function pendingGuestTcl(): {
    tcl: TclCloud;
    seam: {
      pendingPowerCycleRestores: Map<string, unknown>;
      getThingShadow: unknown;
      lastControlVerify: Promise<void> | null;
    };
  } {
    const guest = acDevice({
      id: "DlXqDBFAAAE",
      model: "TAC-24CHSA",
      levelingEligible: false,
      maxGeneratorLevel: 6,
    });
    const tcl = tclWithDevice(guest);
    const seam = tcl as unknown as {
      lastState: Record<string, Record<string, unknown>>;
      pendingPowerCycleRestores: Map<string, unknown>;
      sendControl: unknown;
      publishWithRetry: unknown;
      getThingShadow: unknown;
      controlVerifyDelay: unknown;
      profileSplitDelay: unknown;
      ensureDeviceCachePopulated: unknown;
      lastControlVerify: Promise<void> | null;
    };
    seam.lastState = { DlXqDBFAAAE: { workMode: 1, targetTemperature: 22, windSpeed7Gear: 5 } };
    seam.sendControl = vi.fn(async () => undefined);
    seam.publishWithRetry = vi.fn(async () => undefined);
    seam.controlVerifyDelay = vi.fn(async () => undefined);
    seam.profileSplitDelay = vi.fn(async () => undefined);
    seam.ensureDeviceCachePopulated = vi.fn(async () => undefined);
    return { tcl, seam };
  }

  it("cancels a pending restore on a direct user command (sendControlVerified)", async () => {
    const { tcl, seam } = pendingGuestTcl();
    seam.getThingShadow = vi.fn(async () => ({ reported: { windSpeed7Gear: 3 }, reportedAt: null }));
    expect(tcl.preparePowerCycleRestore("DlXqDBFAAAE")).toBe(true);

    await tcl.sendControlVerified("DlXqDBFAAAE", "set_fan_speed", 3);
    await seam.lastControlVerify;

    expect(seam.pendingPowerCycleRestores.has("DlXqDBFAAAE")).toBe(false);
  });

  it("cancels a pending restore on a verified preset (executeAcActionVerified)", async () => {
    const { tcl, seam } = pendingGuestTcl();
    seam.getThingShadow = vi.fn(async () => ({ reported: { workMode: 1 }, reportedAt: null }));
    expect(tcl.preparePowerCycleRestore("DlXqDBFAAAE")).toBe(true);

    await expect(tcl.executeAcActionVerified("DlXqDBFAAAE", { mode: 1 })).resolves.toBe("applied");

    expect(seam.pendingPowerCycleRestores.has("DlXqDBFAAAE")).toBe(false);
  });

  it("survives background automation enforcement (executeAcAction default options)", async () => {
    const { tcl, seam } = pendingGuestTcl();
    expect(tcl.preparePowerCycleRestore("DlXqDBFAAAE")).toBe(true);

    // Background enforcement is not user intent — it must not un-freeze the restore.
    await tcl.executeAcAction("DlXqDBFAAAE", { mode: 1, temperature: 24, fan_speed: 5 });

    expect(seam.pendingPowerCycleRestores.has("DlXqDBFAAAE")).toBe(true);
  });
});

// A stale-AWS-credential 403 on the live pre-read is the exact event five write
// paths already self-heal from. `validateControlLive` awaited it bare, so that
// 403 made EVERY AC control 500 until token expiry. It now re-auths and retries
// the read ONCE, then degrades to the device's cached capabilities — except for
// Self Clean, which fails closed rather than risk powering off a running AC from
// a stale cache (its payload sets powerSwitch:0 and the route locks it off).
describe("validateControlLive re-auth retry and Self Clean fail-closed", () => {
  it("retries the shadow read after re-auth and validates against the FRESH shadow", async () => {
    const stale = acDevice({
      mode: 3,
      capabilities: deriveAcCapabilities("ac1", "TAC-12CHSD", {
        powerSwitch: 1, workMode: 3, windSpeed: 3, ECO: 0,
      }),
    });
    const tcl = tclWithDevice(stale);
    const seam = tcl as unknown as {
      ensureValidTokens: () => Promise<void>;
      getThingShadow: ReturnType<typeof vi.fn>;
    };
    seam.ensureValidTokens = vi.fn(async () => undefined);
    const getThingShadow = vi.fn()
      .mockRejectedValueOnce(new Error("GetThingShadow HTTP 403: Forbidden"))
      .mockResolvedValueOnce({ reported: { powerSwitch: 1, workMode: 1, windSpeed: 3, ECO: 0 }, reportedAt: null });
    seam.getThingShadow = getThingShadow;

    // Eco is unavailable in the stale Fan-mode cache but available in the fresh
    // Cool-mode shadow the retry fetches: an ok verdict proves the retry won.
    await expect(tcl.validateControlLive("ac1", "set_eco", 1)).resolves.toEqual({ ok: true });
    expect(getThingShadow).toHaveBeenCalledTimes(2);
  });

  it("degrades to cached capabilities when both the read and the re-auth retry fail", async () => {
    const device = acDevice({
      capabilities: deriveAcCapabilities("ac1", "TAC-12CHSD", {
        powerSwitch: 1, workMode: 1, windSpeed: 3, ECO: 0,
      }),
    });
    const tcl = tclWithDevice(device);
    const seam = tcl as unknown as {
      ensureValidTokens: () => Promise<void>;
      getThingShadow: ReturnType<typeof vi.fn>;
    };
    seam.ensureValidTokens = vi.fn(async () => undefined);
    const getThingShadow = vi.fn(async () => { throw new Error("GetThingShadow HTTP 403: Forbidden"); });
    seam.getThingShadow = getThingShadow;

    // Eco is valid against the cached Cool-mode matrix; two failed reads must not
    // throw or 500 the control.
    await expect(tcl.validateControlLive("ac1", "set_eco", 1)).resolves.toEqual({ ok: true });
    expect(getThingShadow).toHaveBeenCalledTimes(2);
  });

  it("fails closed for set_self_clean=1 on the degraded path but not when stopping a cycle", async () => {
    // A clean cycle in progress: powerSwitch off, selfClean on — so the cached
    // Self Clean control is available to STOP, but starting must never be
    // authorized from a stale read.
    const device = acDevice({
      capabilities: deriveAcCapabilities("ac1", "TAC-12CHSD", {
        powerSwitch: 0, workMode: 1, selfClean: 1,
      }),
    });
    const tcl = tclWithDevice(device);
    const seam = tcl as unknown as {
      ensureValidTokens: () => Promise<void>;
      getThingShadow: ReturnType<typeof vi.fn>;
    };
    seam.ensureValidTokens = vi.fn(async () => undefined);
    seam.getThingShadow = vi.fn(async () => { throw new Error("GetThingShadow HTTP 403: Forbidden"); });

    await expect(tcl.validateControlLive("ac1", "set_self_clean", 1)).resolves.toEqual({
      ok: false,
      status: 503,
      error: "Cannot verify the AC's live state for Self Clean right now — try again shortly",
    });
    // Stopping a running clean cycle is safe even from a stale cache.
    await expect(tcl.validateControlLive("ac1", "set_self_clean", 0)).resolves.toEqual({ ok: true });
  });
});
