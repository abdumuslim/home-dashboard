import type { WeatherReading, AirReading } from "@/types/api";
import { OutdoorSection } from "./sections/outdoor-section";
import { IndoorSection } from "./sections/indoor-section";
import { AirQualitySection } from "./sections/air-quality-section";

interface DashboardTabProps {
  weather: WeatherReading | null;
  air: AirReading | null;
  weatherHistory: WeatherReading[];
}

export function DashboardTab({ weather, air, weatherHistory }: DashboardTabProps) {
  return (
    <div className="max-w-[1440px] mx-auto px-5 pt-2 pb-8">
      <OutdoorSection weather={weather} weatherHistory={weatherHistory} />
      <IndoorSection weather={weather} air={air} />
      <AirQualitySection air={air} />
    </div>
  );
}
