import type { WeatherReading, AirReading, OpenOverlayFn } from "@/types/api";
import { OutdoorSection } from "./sections/outdoor-section";
import { IndoorSection } from "./sections/indoor-section";
import { AirQualitySection } from "./sections/air-quality-section";

interface DashboardTabProps {
  weather: WeatherReading | null;
  air: AirReading | null;
  weatherHistory: WeatherReading[];
  airHistory: AirReading[];
  openOverlay: OpenOverlayFn;
}

export function DashboardTab({ weather, air, weatherHistory, airHistory, openOverlay }: DashboardTabProps) {
  return (
    <div className="max-w-[1440px] mx-auto px-5 pt-2 pb-8">
      <OutdoorSection weather={weather} weatherHistory={weatherHistory} openOverlay={openOverlay} />
      <IndoorSection weather={weather} air={air} weatherHistory={weatherHistory} airHistory={airHistory} openOverlay={openOverlay} />
      <AirQualitySection air={air} airHistory={airHistory} openOverlay={openOverlay} />
    </div>
  );
}
