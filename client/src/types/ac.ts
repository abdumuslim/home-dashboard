export interface AcDevice {
  id: string;
  name: string;
  /**
   * Hardware model family — drives protocol/UI differences (e.g. the
   * TAC-24CHSA has a true 7-gear fan; TAC-12CHSD maps 1=silent/7=turbo).
   * Never infer the model from maxGeneratorLevel — TCL changes level counts
   * via firmware updates (Najat went 6 → 3 in 2026-06).
   */
  model: "TAC-24CHSA" | "TAC-12CHSD";
  isOnline: boolean;
  /** Epoch ms of the device's last cloud report (null if unknown) — shown as "last seen" when offline. */
  lastSeenAt?: number | null;
  power: boolean;
  manualOffLocked?: boolean;
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
