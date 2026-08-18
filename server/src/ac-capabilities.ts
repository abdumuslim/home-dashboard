export type AcModel = "TAC-24CHSA" | "TAC-12CHSD";

export interface AcOption {
  value: number;
  label: string;
}

export type AcFeatureId =
  | "eco"
  | "aiEco"
  | "turbo"
  | "sleep"
  | "gentleBreeze"
  | "healthy"
  | "freshAir"
  | "freshAirStrength"
  | "drying"
  | "selfClean"
  | "screen"
  | "lightSense"
  | "beep"
  | "eightDegreeHeat";

export interface AcControlCapability {
  id: AcFeatureId;
  kind: "toggle" | "select" | "action";
  value?: number;
  options?: AcOption[];
  available: boolean;
  unavailableReason?: string;
}

export interface AcCapabilities {
  modes: AcOption[];
  temperature: { min: number; max: number; step: number };
  fanSpeeds: AcOption[];
  verticalSwing: AcOption[];
  horizontalSwing: AcOption[];
  generatorLevels: AcOption[];
  controls: AcControlCapability[];
}

export interface AcDevicePolicy {
  displayName: string;
  displayOrder: number;
  maxGeneratorLevel: number;
  levelingEligible: boolean;
  powerCycleRestoreEligible: boolean;
}

const DEFAULT_POLICY: AcDevicePolicy = {
  displayName: "AC",
  displayOrder: 99,
  maxGeneratorLevel: 3,
  // ESP attribution is a physical wiring fact, so unknown future cloud
  // devices must fail closed until their line is explicitly qualified.
  levelingEligible: false,
  // Last-state restore is granted per VERIFIED physical wiring, never inferred
  // from the absence of other flags: an unknown future AC could be on a line the
  // leveler will own, so "unknown" must not read as "known grid-only" and arm a
  // frozen republish over it.
  powerCycleRestoreEligible: false,
};

const DEVICE_POLICIES: Record<string, AcDevicePolicy> = {
  DHihohFAAAE: { displayName: "Mom", displayOrder: 1, maxGeneratorLevel: 3, levelingEligible: true, powerCycleRestoreEligible: false },
  CA5IMhFAAAE: { displayName: "Abdu", displayOrder: 2, maxGeneratorLevel: 3, levelingEligible: true, powerCycleRestoreEligible: false },
  Cy3aihFAAAE: { displayName: "Abdullah", displayOrder: 3, maxGeneratorLevel: 3, levelingEligible: true, powerCycleRestoreEligible: false },
  DlXqDBFAAAE: { displayName: "Guest", displayOrder: 4, maxGeneratorLevel: 6, levelingEligible: false, powerCycleRestoreEligible: true },
};

/**
 * Shadow schemas are shared across several TCL firmwares and can contain
 * writable-looking placeholder properties for hardware the physical unit does
 * not have. Keep the four household units fail-closed at the UI/command
 * boundary: a property must exist AND the feature must be verified for that
 * stable device id. Unknown/test devices retain property discovery so protocol
 * probes and fixtures can still be evaluated without pretending they are one
 * of these physical units.
 */
const VERIFIED_CONTROL_FEATURES: Partial<Record<string, ReadonlySet<AcFeatureId>>> = {
  DHihohFAAAE: new Set([
    "aiEco", "sleep", "gentleBreeze", "freshAir", "freshAirStrength", "drying",
    "selfClean", "screen", "lightSense", "beep", "eightDegreeHeat",
  ]),
  CA5IMhFAAAE: new Set([
    "eco", "turbo", "sleep", "healthy", "drying", "selfClean", "screen",
    "lightSense", "beep", "eightDegreeHeat",
  ]),
  Cy3aihFAAAE: new Set([
    "eco", "turbo", "sleep", "gentleBreeze", "healthy", "drying", "selfClean",
    "screen", "lightSense", "beep", "eightDegreeHeat",
  ]),
  DlXqDBFAAAE: new Set([
    "eco", "aiEco", "sleep", "gentleBreeze", "healthy", "drying", "selfClean",
    "screen", "beep", "eightDegreeHeat",
  ]),
};

function verifiedForDevice(deviceId: string, feature: AcFeatureId): boolean {
  const verified = VERIFIED_CONTROL_FEATURES[deviceId];
  return verified == null || verified.has(feature);
}

export function getAcDevicePolicy(deviceId: string): AcDevicePolicy {
  return DEVICE_POLICIES[deviceId] ?? DEFAULT_POLICY;
}

export function isAcLevelingEligible(deviceId: string): boolean {
  return getAcDevicePolicy(deviceId).levelingEligible;
}

export function isPowerCycleRestoreEligible(deviceId: string): boolean {
  return getAcDevicePolicy(deviceId).powerCycleRestoreEligible;
}

export function maxGeneratorLevelForDevices(deviceIds: string[]): number {
  if (deviceIds.length === 0) return DEFAULT_POLICY.maxGeneratorLevel;
  return Math.min(...deviceIds.map((deviceId) => getAcDevicePolicy(deviceId).maxGeneratorLevel));
}

export function validateLevelingDeviceReferences(config: Record<string, unknown>): string | null {
  const referenceGroups: Array<[string, string[]]> = [
    ["priority", Array.isArray(config.priority) ? config.priority.filter((id): id is string => typeof id === "string") : []],
    ...["ampModels", "genAmpModels", "levelBoosts", "needOverrides"].map((field) => [
      field,
      config[field] && typeof config[field] === "object" && !Array.isArray(config[field])
        ? Object.keys(config[field] as Record<string, unknown>)
        : [],
    ] as [string, string[]]),
  ];
  for (const [field, deviceIds] of referenceGroups) {
    const deviceId = deviceIds.find((id) => !isAcLevelingEligible(id));
    if (deviceId) return `${getAcDevicePolicy(deviceId).displayName} is not eligible for ESP leveling (${field})`;
  }
  return null;
}

function has(shadow: Record<string, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(shadow, property);
}

function numberValue(shadow: Record<string, unknown>, property: string, fallback = 0): number {
  return typeof shadow[property] === "number" ? shadow[property] : fallback;
}

function numberedOptions(values: number[], zeroLabel = "Auto"): AcOption[] {
  return values.map((value) => ({ value, label: value === 0 ? zeroLabel : String(value) }));
}

const MODE_OPTIONS: AcOption[] = [
  { value: 0, label: "Auto" },
  { value: 1, label: "Cool" },
  { value: 2, label: "Dry" },
  { value: 3, label: "Fan" },
  { value: 4, label: "Heat" },
];

const SLEEP_OPTIONS: AcOption[] = [
  { value: 0, label: "Off" },
  { value: 1, label: "Standard" },
  { value: 2, label: "Elderly" },
  { value: 3, label: "Child" },
];

const GENTLE_BREEZE_OPTIONS: AcOption[] = [
  { value: 0, label: "Off" },
  { value: 1, label: "Soft" },
  { value: 2, label: "Shower" },
  { value: 3, label: "Carpet" },
  { value: 4, label: "Surround" },
];

const FRESH_AIR_OPTIONS: AcOption[] = [
  { value: 0, label: "Auto" },
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
];

const VERTICAL_SWING_VALUES = [0, 1, 2, 3, 9, 10, 11, 12, 13];
const HORIZONTAL_SWING_VALUES = [0, 1, 2, 3, 4, 9, 10, 11, 12, 13];

function availability(
  available: boolean,
  unavailableReason: string,
): Pick<AcControlCapability, "available" | "unavailableReason"> {
  return available ? { available: true } : { available: false, unavailableReason };
}

/**
 * Build the user-facing contract from THIS physical AC's reported shadow.
 * Protocol-family labels only choose encodings; property presence decides
 * whether a feature exists.
 */
export function deriveAcCapabilities(
  deviceId: string,
  model: AcModel,
  shadow: Record<string, unknown>,
): AcCapabilities {
  const policy = getAcDevicePolicy(deviceId);
  const power = numberValue(shadow, "powerSwitch") === 1;
  const mode = numberValue(shadow, "workMode");
  const coolOrHeat = mode === 1 || mode === 4;
  const reportedCapabilities = Array.isArray(shadow.capabilities) ? shadow.capabilities : [];

  const fanSpeeds: AcOption[] = [];
  if (has(shadow, "windSpeed7Gear")) {
    fanSpeeds.push({ value: 0, label: "Auto" }, ...numberedOptions([1, 2, 3, 4, 5, 6, 7], "Auto"));
  } else if (has(shadow, "windSpeed") || has(shadow, "silenceSwitch") || has(shadow, "turbo")) {
    fanSpeeds.push({ value: 0, label: "Auto" });
    if (has(shadow, "silenceSwitch")) fanSpeeds.push({ value: 1, label: "Silent" });
    if (has(shadow, "windSpeed")) fanSpeeds.push(...numberedOptions([2, 3, 4, 5, 6], "Auto"));
    if (has(shadow, "turbo")) fanSpeeds.push({ value: 7, label: "Max" });
  }

  const verticalSwing = has(shadow, model === "TAC-24CHSA" ? "verticalWind" : "verticalSwitch")
    ? numberedOptions(VERTICAL_SWING_VALUES, "Off")
    : [];
  const horizontalSwing = has(shadow, model === "TAC-24CHSA" ? "horizontalWind" : "horizontalSwitch")
    ? numberedOptions(HORIZONTAL_SWING_VALUES, "Off")
    : [];
  const supportsGenerator = has(shadow, "generatorMode") || reportedCapabilities.includes(23) || deviceId === "DlXqDBFAAAE";
  const generatorLevels = supportsGenerator
    ? numberedOptions(Array.from({ length: policy.maxGeneratorLevel + 1 }, (_, index) => index), "Off")
    : [];

  const controls: AcControlCapability[] = [];
  const addToggle = (
    id: AcFeatureId,
    property: string,
    gate: Pick<AcControlCapability, "available" | "unavailableReason"> = { available: true },
  ) => {
    if (!verifiedForDevice(deviceId, id) || !has(shadow, property)) return;
    controls.push({ id, kind: "toggle", value: numberValue(shadow, property), ...gate });
  };

  addToggle("eco", "ECO", availability(power && coolOrHeat, "Available in Cool or Heat mode"));
  addToggle("aiEco", "AIECOSwitch", availability(power && coolOrHeat, "Available in Cool or Heat mode"));
  addToggle("turbo", "turbo", availability(power && coolOrHeat, "Available in Cool or Heat mode"));
  if (verifiedForDevice(deviceId, "sleep") && has(shadow, "sleep")) {
    controls.push({
      id: "sleep",
      kind: "select",
      value: numberValue(shadow, "sleep"),
      options: SLEEP_OPTIONS,
      ...availability(power && mode !== 3, "Unavailable in Fan mode"),
    });
  }
  if (verifiedForDevice(deviceId, "gentleBreeze") && (has(shadow, "softWind") || reportedCapabilities.includes(5))) {
    const hasWindFeeling = has(shadow, "newWindSwitch") || has(shadow, "newWindStrength");
    controls.push(hasWindFeeling
      ? {
          id: "gentleBreeze",
          kind: "select",
          value: numberValue(shadow, "softWind"),
          options: GENTLE_BREEZE_OPTIONS,
          ...availability(power && mode === 1, "Available in Cool mode"),
        }
      : {
          id: "gentleBreeze",
          kind: "toggle",
          value: numberValue(shadow, "softWind"),
          ...availability(power && mode === 1, "Available in Cool mode"),
        });
  }
  addToggle("healthy", "healthy", availability(power, "Turn the AC on first"));
  addToggle("freshAir", "newWindSwitch", availability(power && mode !== 2, "Unavailable in Dry mode"));
  if (verifiedForDevice(deviceId, "freshAirStrength") && has(shadow, "newWindStrength")) {
    controls.push({
      id: "freshAirStrength",
      kind: "select",
      value: numberValue(shadow, "newWindAutoSwitch") === 1 ? 0 : numberValue(shadow, "newWindStrength"),
      options: FRESH_AIR_OPTIONS,
      ...availability(power && numberValue(shadow, "newWindSwitch") === 1, "Turn Fresh Air on first"),
    });
  }
  addToggle("drying", "antiMoldew", availability(
    power && (mode === 1 || mode === 2) && numberValue(shadow, "eightAddHot") !== 1,
    "Available in Cool or Dry mode",
  ));
  if (verifiedForDevice(deviceId, "selfClean") && has(shadow, "selfClean")) {
    const active = numberValue(shadow, "selfClean") === 1;
    controls.push({
      id: "selfClean",
      kind: "action",
      value: active ? 1 : 0,
      ...availability(!power || active, "Turn the AC off first"),
    });
  }
  addToggle("screen", "screen");
  addToggle("lightSense", "lightSense");
  addToggle("beep", "beepSwitch");
  if (verifiedForDevice(deviceId, "eightDegreeHeat") && (has(shadow, "eightAddHot") || reportedCapabilities.includes(21))) {
    controls.push({
      id: "eightDegreeHeat",
      kind: "toggle",
      value: numberValue(shadow, "eightAddHot"),
      ...availability(power && mode === 4, "Available in Heat mode"),
    });
  }

  return {
    modes: has(shadow, "workMode") ? MODE_OPTIONS : [],
    temperature: { min: 16, max: 36, step: model === "TAC-24CHSA" ? 0.5 : 1 },
    fanSpeeds,
    verticalSwing,
    horizontalSwing,
    generatorLevels,
    controls,
  };
}

const COMMAND_FEATURE: Partial<Record<string, AcFeatureId>> = {
  set_eco: "eco",
  set_ai_eco: "aiEco",
  set_turbo: "turbo",
  set_sleep: "sleep",
  set_gentle_breeze: "gentleBreeze",
  set_healthy: "healthy",
  set_fresh_air: "freshAir",
  set_fresh_air_strength: "freshAirStrength",
  set_drying: "drying",
  set_self_clean: "selfClean",
  set_screen: "screen",
  set_light_sense: "lightSense",
  set_beep: "beep",
  set_8c_heat: "eightDegreeHeat",
};

export type AcControlValidation =
  | { ok: true }
  | { ok: false; status: 400 | 409; error: string };

function optionValidation(label: string, options: AcOption[], value: unknown): AcControlValidation {
  if (typeof value === "number" && options.some((option) => option.value === value)) return { ok: true };
  return {
    ok: false,
    status: 400,
    error: `${label} must be one of ${options.map((option) => option.value).join(", ")}`,
  };
}

export function supportsAcCommand(capabilities: AcCapabilities, command: string, value?: unknown): boolean {
  if (command === "set_power") return value == null || value === 0 || value === 1;
  if (command === "set_temperature") {
    if (value == null) return true;
    const { min, max, step } = capabilities.temperature;
    return typeof value === "number"
      && Number.isFinite(value)
      && value >= min
      && value <= max
      && Math.abs((value - min) / step - Math.round((value - min) / step)) < 1e-6;
  }
  if (command === "set_mode") return value == null ? capabilities.modes.length > 0 : capabilities.modes.some((option) => option.value === value);
  if (command === "set_fan_speed") return value == null ? capabilities.fanSpeeds.length > 0 : capabilities.fanSpeeds.some((option) => option.value === value);
  if (command === "set_vertical_swing") return value == null ? capabilities.verticalSwing.length > 0 : capabilities.verticalSwing.some((option) => option.value === value);
  if (command === "set_horizontal_swing") return value == null ? capabilities.horizontalSwing.length > 0 : capabilities.horizontalSwing.some((option) => option.value === value);
  // Stored presets may contain a positive level from older firmware; the TCL
  // layer clamps it to the physical device's current maximum. Negative,
  // fractional, and non-numeric values are never valid legacy state.
  if (command === "set_generator_mode") {
    return capabilities.generatorLevels.length > 0
      && (value == null || (typeof value === "number" && Number.isInteger(value) && value >= 0));
  }
  const featureId = COMMAND_FEATURE[command];
  if (!featureId) return false;
  const control = capabilities.controls.find((candidate) => candidate.id === featureId);
  if (!control) return false;
  if (value == null) return true;
  if (control.kind === "select") return (control.options ?? []).some((option) => option.value === value);
  return value === 0 || value === 1;
}

export function validateAcControl(capabilities: AcCapabilities, command: string, value: unknown): AcControlValidation {
  if (command === "set_power") return optionValidation("power", numberedOptions([0, 1], "0"), value);
  if (command === "set_mode") return optionValidation("mode", capabilities.modes, value);
  if (command === "set_fan_speed") return optionValidation("fan speed", capabilities.fanSpeeds, value);
  if (command === "set_vertical_swing") return optionValidation("vertical swing", capabilities.verticalSwing, value);
  if (command === "set_horizontal_swing") return optionValidation("horizontal swing", capabilities.horizontalSwing, value);
  if (command === "set_generator_mode") return optionValidation("generator level", capabilities.generatorLevels, value);
  if (command === "set_temperature") {
    const { min, max, step } = capabilities.temperature;
    const aligned = typeof value === "number" && Math.abs((value - min) / step - Math.round((value - min) / step)) < 1e-6;
    return typeof value === "number" && value >= min && value <= max && aligned
      ? { ok: true }
      : { ok: false, status: 400, error: `temperature must be ${min}–${max} in ${step}° steps` };
  }

  const featureId = COMMAND_FEATURE[command];
  if (!featureId) return { ok: false, status: 400, error: `Unknown AC command: ${command}` };
  const control = capabilities.controls.find((candidate) => candidate.id === featureId);
  if (!control) return { ok: false, status: 400, error: `${command} is not supported by this AC` };
  if (!control.available) return { ok: false, status: 409, error: control.unavailableReason ?? "Feature is currently unavailable" };
  if (control.kind === "select") return optionValidation(featureId, control.options ?? [], value);
  return optionValidation(featureId, numberedOptions([0, 1], "0"), value);
}

export function buildAdvancedControlPayload(command: string, value: unknown): Record<string, number> | null {
  if (typeof value !== "number") return null;
  switch (command) {
    case "set_ai_eco": return { eightAddHot: 0, AIECOSwitch: value };
    case "set_gentle_breeze": return value === 2
      ? { horizontalDirection: 8, softWind: 2, verticalDirection: 9 }
      : value === 3
        ? { horizontalDirection: 8, softWind: 3, verticalDirection: 13 }
        : value === 4
          ? { softWind: 4, verticalDirection: 8 }
          : value === 1
            ? { horizontalDirection: 8, softWind: 1 }
            : { softWind: 0 };
    case "set_healthy": return { healthy: value };
    case "set_fresh_air": return value === 1 ? { newWindSwitch: 1, selfClean: 0 } : { newWindSwitch: 0 };
    case "set_fresh_air_strength": return value === 0
      ? { newWindAutoSwitch: 1, newWindStrength: 0 }
      : { newWindAutoSwitch: 0, newWindStrength: value };
    case "set_drying": return { antiMoldew: value };
    case "set_self_clean": return value === 1 ? { powerSwitch: 0, selfClean: 1 } : { selfClean: 0 };
    case "set_light_sense": return { lightSense: value };
    case "set_8c_heat": return { eightAddHot: value };
    default: return null;
  }
}
