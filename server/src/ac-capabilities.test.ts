import { describe, expect, it } from "vitest";
import {
  buildAdvancedControlPayload,
  deriveAcCapabilities,
  getAcDevicePolicy,
  maxGeneratorLevelForDevices,
  supportsAcCommand,
  validateLevelingDeviceReferences,
  validateAcControl,
} from "./ac-capabilities.js";
import { LIVE_AC_CAPABILITY_SHADOWS } from "./fixtures/ac-capability-shadows.js";

const GUEST_ID = "DlXqDBFAAAE";

describe("per-device AC policy", () => {
  it("keeps Guest on six levels and outside the ESP leveling line", () => {
    expect(getAcDevicePolicy(GUEST_ID)).toEqual({
      displayName: "guest",
      displayOrder: 4,
      maxGeneratorLevel: 6,
      levelingEligible: false,
    });
  });

  it("keeps the three ESP-measured ACs ordered and leveling-eligible", () => {
    expect([
      getAcDevicePolicy("DHihohFAAAE"),
      getAcDevicePolicy("CA5IMhFAAAE"),
      getAcDevicePolicy("Cy3aihFAAAE"),
    ]).toEqual([
      { displayName: "Mom", displayOrder: 1, maxGeneratorLevel: 3, levelingEligible: true },
      { displayName: "Abdu", displayOrder: 2, maxGeneratorLevel: 3, levelingEligible: true },
      { displayName: "Abdullah", displayOrder: 3, maxGeneratorLevel: 3, levelingEligible: true },
    ]);
  });

  it("fails closed for unknown future TCL devices", () => {
    expect(getAcDevicePolicy("new-cloud-device").levelingEligible).toBe(false);
    expect(validateLevelingDeviceReferences({ priority: ["new-cloud-device"] })).toContain("priority");
  });

  it("uses the lowest maximum across mixed automation targets", () => {
    expect(maxGeneratorLevelForDevices([GUEST_ID])).toBe(6);
    expect(maxGeneratorLevelForDevices([GUEST_ID, "DHihohFAAAE"])).toBe(3);
  });

  it("rejects Guest in every leveling-owned configuration map", () => {
    expect(validateLevelingDeviceReferences({ priority: [GUEST_ID] })).toContain("priority");
    expect(validateLevelingDeviceReferences({ ampModels: { [GUEST_ID]: {} } })).toContain("ampModels");
    expect(validateLevelingDeviceReferences({ genAmpModels: { [GUEST_ID]: {} } })).toContain("genAmpModels");
    expect(validateLevelingDeviceReferences({ levelBoosts: { [GUEST_ID]: {} } })).toContain("levelBoosts");
    expect(validateLevelingDeviceReferences({ needOverrides: { [GUEST_ID]: {} } })).toContain("needOverrides");
  });
});

describe("shadow-derived AC capabilities", () => {
  it("derives Guest's verified extended controls and L1-L6 from its own shadow", () => {
    const capabilities = deriveAcCapabilities(GUEST_ID, "TAC-24CHSA", LIVE_AC_CAPABILITY_SHADOWS[GUEST_ID]);

    expect(capabilities.generatorLevels.map((option) => option.value)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(capabilities.fanSpeeds.map((option) => option.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(capabilities.controls.map((control) => control.id)).toEqual([
      "eco",
      "aiEco",
      "sleep",
      "gentleBreeze",
      "healthy",
      "drying",
      "selfClean",
      "screen",
      "beep",
      "eightDegreeHeat",
    ]);
  });

  it("keeps different feature sets for live ACs in the same protocol family", () => {
    const mom = deriveAcCapabilities("DHihohFAAAE", "TAC-24CHSA", LIVE_AC_CAPABILITY_SHADOWS.DHihohFAAAE);
    const guest = deriveAcCapabilities(GUEST_ID, "TAC-24CHSA", LIVE_AC_CAPABILITY_SHADOWS[GUEST_ID]);

    expect(mom.controls.map((control) => control.id)).toContain("freshAir");
    expect(mom.controls.map((control) => control.id)).toContain("lightSense");
    expect(mom.controls.map((control) => control.id)).not.toContain("healthy");
    expect(guest.controls.map((control) => control.id)).toContain("healthy");
    expect(guest.controls.map((control) => control.id)).not.toContain("freshAir");
    expect(guest.controls.map((control) => control.id)).not.toContain("lightSense");
  });

  it("loads all four sanitized live capability fixtures", () => {
    expect(Object.keys(LIVE_AC_CAPABILITY_SHADOWS)).toEqual([
      "DHihohFAAAE",
      "CA5IMhFAAAE",
      "Cy3aihFAAAE",
      GUEST_ID,
    ]);
    const matrices = [
      deriveAcCapabilities("DHihohFAAAE", "TAC-24CHSA", LIVE_AC_CAPABILITY_SHADOWS.DHihohFAAAE),
      deriveAcCapabilities("CA5IMhFAAAE", "TAC-12CHSD", LIVE_AC_CAPABILITY_SHADOWS.CA5IMhFAAAE),
      deriveAcCapabilities("Cy3aihFAAAE", "TAC-12CHSD", LIVE_AC_CAPABILITY_SHADOWS.Cy3aihFAAAE),
      deriveAcCapabilities(GUEST_ID, "TAC-24CHSA", LIVE_AC_CAPABILITY_SHADOWS[GUEST_ID]),
    ];
    expect(matrices.every((capabilities) => capabilities.modes.length > 0)).toBe(true);
    expect(matrices.map((capabilities) => capabilities.generatorLevels.at(-1)?.value)).toEqual([3, 3, 3, 6]);
  });

  it("filters legacy preset fields by physical support, not current availability", () => {
    const capabilities = deriveAcCapabilities(GUEST_ID, "TAC-12CHSD", {
      powerSwitch: 0,
      workMode: 1,
      ECO: 0,
      generatorMode: 6,
    });

    expect(supportsAcCommand(capabilities, "set_eco", 1)).toBe(true);
    expect(supportsAcCommand(capabilities, "set_turbo", 1)).toBe(false);
    expect(supportsAcCommand(capabilities, "set_generator_mode", 6)).toBe(true);
    expect(supportsAcCommand(capabilities, "set_generator_mode", -1)).toBe(false);
    expect(supportsAcCommand(capabilities, "set_eco", 4)).toBe(false);
    expect(supportsAcCommand(capabilities, "set_temperature", 24.5)).toBe(false);
  });

  it("keeps supported controls visible but unavailable when the current mode forbids them", () => {
    const capabilities = deriveAcCapabilities(GUEST_ID, "TAC-12CHSD", {
      powerSwitch: 1,
      workMode: 3,
      targetTemperature: 24,
      windSpeed: 3,
      ECO: 0,
      turbo: 0,
      selfClean: 0,
      eightAddHot: 0,
      generatorMode: 0,
    });

    expect(capabilities.controls.find((control) => control.id === "eco")).toMatchObject({
      available: false,
      unavailableReason: "Available in Cool or Heat mode",
    });
    expect(capabilities.controls.find((control) => control.id === "selfClean")).toMatchObject({
      available: false,
      unavailableReason: "Turn the AC off first",
    });
    expect(capabilities.controls.find((control) => control.id === "eightDegreeHeat")).toMatchObject({
      available: false,
      unavailableReason: "Available in Heat mode",
    });
  });
});

describe("capability-aware AC commands", () => {
  it("accepts Guest L6, rejects L6 for Mom, and rejects unsupported feature commands", () => {
    const guest = deriveAcCapabilities(GUEST_ID, "TAC-12CHSD", { powerSwitch: 0, generatorMode: 0 });
    const mom = deriveAcCapabilities("DHihohFAAAE", "TAC-24CHSA", {
      powerSwitch: 1,
      workMode: 1,
      generatorMode: 2,
      windSpeed7Gear: 3,
    });

    expect(validateAcControl(guest, "set_generator_mode", 6)).toEqual({ ok: true });
    expect(validateAcControl(mom, "set_generator_mode", 6)).toEqual({
      ok: false,
      status: 400,
      error: "generator level must be one of 0, 1, 2, 3",
    });
    expect(validateAcControl(mom, "set_healthy", 1)).toEqual({
      ok: false,
      status: 400,
      error: "set_healthy is not supported by this AC",
    });
  });

  it("returns 409 for a supported feature that is unavailable in the current mode", () => {
    const guest = deriveAcCapabilities(GUEST_ID, "TAC-12CHSD", {
      powerSwitch: 1,
      workMode: 3,
      generatorMode: 0,
      ECO: 0,
    });

    expect(validateAcControl(guest, "set_eco", 1)).toEqual({
      ok: false,
      status: 409,
      error: "Available in Cool or Heat mode",
    });
  });

  it("encodes multi-property feature commands without exposing raw shadow writes", () => {
    expect(buildAdvancedControlPayload("set_ai_eco", 1)).toEqual({ eightAddHot: 0, AIECOSwitch: 1 });
    expect(buildAdvancedControlPayload("set_fresh_air_strength", 0)).toEqual({ newWindAutoSwitch: 1, newWindStrength: 0 });
    expect(buildAdvancedControlPayload("set_fresh_air_strength", 3)).toEqual({ newWindAutoSwitch: 0, newWindStrength: 3 });
    expect(buildAdvancedControlPayload("set_self_clean", 1)).toEqual({ powerSwitch: 0, selfClean: 1 });
    expect(buildAdvancedControlPayload("set_self_clean", 0)).toEqual({ selfClean: 0 });
  });
});
