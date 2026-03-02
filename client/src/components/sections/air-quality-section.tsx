import { AirQualityCard } from "@/components/cards/air-quality-card";
import type { AirReading, OpenOverlayFn } from "@/types/api";

interface AirQualitySectionProps {
  air: AirReading | null;
  airHistory: AirReading[];
  openOverlay: OpenOverlayFn;
}

export function AirQualitySection({ air, airHistory, openOverlay }: AirQualitySectionProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <AirQualityCard
        title="PM2.5"
        value={air?.pm25}
        unit="µg/m³"
        metric="pm25"
        airHistory={airHistory}
        openOverlay={openOverlay}
      />
      <AirQualityCard
        title="PM10"
        value={air?.pm10}
        unit="µg/m³"
        metric="pm10"
        airHistory={airHistory}
        openOverlay={openOverlay}
      />
      <AirQualityCard
        title="tVOC"
        value={air?.tvoc}
        unit="index"
        metric="tvoc"
        airHistory={airHistory}
        openOverlay={openOverlay}
      />
      <AirQualityCard
        title={<>CO<sub>2</sub></>}
        value={air?.co2}
        unit="ppm"
        metric="co2"
        airHistory={airHistory}
        openOverlay={openOverlay}
      />
    </div>
  );
}
