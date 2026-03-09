import { Home, User, CookingPot } from "lucide-react";
import type { WeatherReading, AirReading, PowerReading, OpenOverlayFn } from "@/types/api";
import type { PurifierDevice } from "@/types/automations";
import type { AcDevice } from "@/types/ac";
import { IndoorCard } from "@/components/cards/indoor-card";
import { PowerCard } from "@/components/cards/power-card";

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

// Steadman approximation for feels-like (indoor, no wind/sun)
function calcFeelsLike(t: number, rh: number): number {
  // Simple heat-index for indoor (no wind). Below 20°C just return temp.
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

  // Match purifier devices to indoor cards by name (case-insensitive)
  const momDevice = devices.find((d) => d.name.toLowerCase() === "mom");
  const abduDevice = devices.find((d) => d.name.toLowerCase() === "abdu");

  // Match AC devices by name: "Najat" → Mom card, "Abdu AC" → Abdu card
  const momAc = acDevices.find((d) => d.name.toLowerCase().includes("najat"));
  const abduAc = acDevices.find((d) => d.name.toLowerCase().startsWith("abdu") && !d.name.toLowerCase().includes("abdullah"));

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
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
        device={momDevice}
        onControl={momDevice && sendControl ? (cmd, params) => sendControl(momDevice.id, cmd, params) : undefined}
        acDevice={momAc}
        onAcControl={momAc && acSendControl ? (cmd, val) => acSendControl(momAc.id, cmd, val) : undefined}
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
        device={abduDevice}
        onControl={abduDevice && sendControl ? (cmd, params) => sendControl(abduDevice.id, cmd, params) : undefined}
        acDevice={abduAc}
        onAcControl={abduAc && acSendControl ? (cmd, val) => acSendControl(abduAc.id, cmd, val) : undefined}
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
