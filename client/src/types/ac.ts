export interface AcOption {
  value: number;
  label: string;
}

export type AcFeatureId =
  | "eco" | "aiEco" | "turbo" | "sleep" | "gentleBreeze"
  | "healthy" | "freshAir" | "freshAirStrength" | "drying"
  | "selfClean" | "screen" | "lightSense" | "beep" | "eightDegreeHeat";

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

export interface AcDevice {
  id: string;
  name: string;
  displayName: string;
  displayOrder: number;
  levelingEligible: boolean;
  capabilities: AcCapabilities;
  /**
   * Protocol encoding family only. UI controls come exclusively from
   * `capabilities`, which is derived from this physical unit's live shadow.
   */
  model: "TAC-24CHSA" | "TAC-12CHSD";
  isOnline: boolean;
  /** Epoch ms of the device's last cloud report (null if unknown) — shown as "last seen" when offline. */
  lastSeenAt?: number | null;
  power: boolean;
  manualOffLocked?: boolean;
  /** Armed one-shot OFF that fires when this offline unit reports again (grid-only Guest). */
  offWhenOnline?: boolean;
  mode: number;
  targetTemp: number;
  currentTemp: number;
  fanSpeed: number;
  eco: boolean;
  sleep: number;
  screen: boolean;
  verticalSwing: number;
  horizontalSwing: number;
  turbo: boolean;
  freshAir: boolean;
  hasFreshAir: boolean;
  generatorMode: number;
  maxGeneratorLevel: number;
  tempStep: number;
  minFanSpeed: number;
  maxFanSpeed: number;
  beep: boolean;
}
