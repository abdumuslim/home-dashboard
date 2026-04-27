import { Home, User, CookingPot } from "lucide-react";
import type { WeatherReading, AirReading, PowerReading, OpenOverlayFn } from "@/types/api";
import type { PurifierDevice } from "@/types/automations";
import type { AcDevice } from "@/types/ac";
import { IndoorCard } from "@/components/cards/indoor-card";
import { PowerCard } from "@/components/cards/power-card";
import { DevicesCard, type AcEntry, type PurifierEntry } from "@/components/cards/devices-card";
import { useAcTimers } from "@/components/ac-widget";

interface IndoorSectionProps {
  weather: WeatherReading | null;
  air: AirReading | null;
  weatherHistory: WeatherReading[];
  airHistory: AirReading[];
  openOverlay: OpenOverlayFn;
  devices?: PurifierDevice[];
  sendControl?: (deviceId: string, command: string, params: unknown[]) => Promise<void>;
  acDevices?: AcDevice[];
  acSendControl?: (deviceId: string, command: string, value: unknown) => Promise<void>;
  power?: PowerReading | null;
  powerHistory?: PowerReading[];
}

function calcFeelsLike(t: number, rh: number): number {
  if (t < 20) return t;
  const hi =
    -8.7847 + 1.6114 * t + 2.3385 * rh - 0.14612 * t * rh -
    0.012308 * t * t - 0.016424 * rh * rh + 0.002211 * t * t * rh +
    0.00072546 * t * rh * rh - 0.000003582 * t * t * rh * rh;
  return hi;
}

export function IndoorSection({ weather, air, weatherHistory, airHistory, openOverlay, devices = [], sendControl, acDevices = [], acSendControl, power, powerHistory = [] }: IndoorSectionProps) {
  const kitchenFeelsLike = air?.temperature != null && air?.humidity != null
    ? calcFeelsLike(air.temperature, air.humidity) : undefined;

  const { timers, setTimer, cancelTimer } = useAcTimers();

  // Purifiers
  const momDevice = devices.find((d) => d.name.toLowerCase() === "mom");
  const abduDevice = devices.find((d) => d.name.toLowerCase() === "abdu");

  // ACs — all 3
  const momAc = acDevices.find((d) => d.name.toLowerCase().includes("najat"));
  const abduAc = acDevices.find((d) => d.name.toLowerCase().startsWith("abdu") && !d.name.toLowerCase().includes("abdullah"));
  const abdullahAc = acDevices.find((d) => d.name.toLowerCase().includes("abdullah"));

  const acEntries: AcEntry[] = [
    momAc && acSendControl && {
      device: momAc,
      label: "Mom",
      onControl: (cmd: string, val: unknown) => acSendControl(momAc.id, cmd, val),
      timer: timers.find((t) => t.deviceId === momAc.id) ?? null,
      onSetTimer: (a: "on" | "off", m: number, p?: Record<string, unknown>) => setTimer(momAc.id, a, m, p),
      onCancelTimer: () => cancelTimer(momAc.id),
    },
    abduAc && acSendControl && {
      device: abduAc,
      label: "Abdu",
      onControl: (cmd: string, val: unknown) => acSendControl(abduAc.id, cmd, val),
      timer: timers.find((t) => t.deviceId === abduAc.id) ?? null,
      onSetTimer: (a: "on" | "off", m: number, p?: Record<string, unknown>) => setTimer(abduAc.id, a, m, p),
      onCancelTimer: () => cancelTimer(abduAc.id),
    },
    abdullahAc && acSendControl && {
      device: abdullahAc,
      label: "Abdullah",
      onControl: (cmd: string, val: unknown) => acSendControl(abdullahAc.id, cmd, val),
      timer: timers.find((t) => t.deviceId === abdullahAc.id) ?? null,
      onSetTimer: (a: "on" | "off", m: number, p?: Record<string, unknown>) => setTimer(abdullahAc.id, a, m, p),
      onCancelTimer: () => cancelTimer(abdullahAc.id),
    },
  ].filter(Boolean) as AcEntry[];

  const purifierEntries: PurifierEntry[] = [
    momDevice && sendControl && {
      device: momDevice,
      label: "Mom",
      onControl: (cmd: string, params: unknown[]) => sendControl(momDevice.id, cmd, params),
    },
    abduDevice && sendControl && {
      device: abduDevice,
      label: "Abdu",
      onControl: (cmd: string, params: unknown[]) => sendControl(abduDevice.id, cmd, params),
    },
  ].filter(Boolean) as PurifierEntry[];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3">
      <DevicesCard acs={acEntries} purifiers={purifierEntries} />
      <IndoorCard
        title="Mom"
        icon={<Home className="w-full h-full" />}
        iconColor="blue"
        temp={weather?.temp_indoor_c}
        humidity={weather?.humidity_indoor}
        feelsLike={weather?.feels_like_indoor_c}
        history={weatherHistory}
        metricKey="temp_indoor_c"
        openOverlay={openOverlay}
      />
      <IndoorCard
        title="Abdu"
        icon={<User className="w-full h-full" />}
        iconColor="purple"
        temp={weather?.temp_ch8_c}
        humidity={weather?.humidity_ch8}
        feelsLike={weather?.feels_like_ch8_c}
        history={weatherHistory}
        metricKey="temp_ch8_c"
        openOverlay={openOverlay}
      />
      <IndoorCard
        title="Kitchen"
        icon={<CookingPot className="w-full h-full" />}
        iconColor="green"
        temp={air?.temperature}
        humidity={air?.humidity}
        feelsLike={kitchenFeelsLike}
        noise={air?.noise}
        history={airHistory}
        metricKey="temperature"
        openOverlay={openOverlay}
      />
      <PowerCard
        power={power ?? null}
        powerHistory={powerHistory}
        openOverlay={openOverlay}
      />
    </div>
  );
}
