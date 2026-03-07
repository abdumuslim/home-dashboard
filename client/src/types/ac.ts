export interface AcDevice {
  id: string;
  name: string;
  isOnline: boolean;
  power: boolean;
  mode: number;
  targetTemp: number;
  currentTemp: number;
  fanSpeed: number;
  eco: boolean;
  sleep: number;
  screen: boolean;
  swing: boolean;
  turbo: boolean;
  generatorMode: number;
  maxGeneratorLevel: number;
}
