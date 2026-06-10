export interface AcDevice {
  id: string;
  name: string;
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
