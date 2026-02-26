import { Atom, CircleDot, Cloud, Battery } from "lucide-react";
import type { AirReading } from "@/types/api";
import { AirQualityCard } from "@/components/cards/air-quality-card";

interface AirQualitySectionProps {
  air: AirReading | null;
}

export function AirQualitySection({ air }: AirQualitySectionProps) {
  return (
    <section className="mb-6">
      <div className="flex justify-between items-baseline px-0.5 pt-3 pb-2">
        <h2 className="text-base font-semibold">Air Quality</h2>
        <span className="text-[0.75rem] text-dim">
          Qingping CGS1{" "}
          <span className="text-dim ml-2" title="Battery">
            <Battery className="inline w-3.5 h-3.5 text-green align-[-2px]" />{" "}
            {air?.battery ?? "--"}%
          </span>
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <AirQualityCard
          title={<>CO<sub>2</sub></>}
          icon={<Atom className="w-full h-full" />}
          iconColor="yellow"
          value={air?.co2}
          unit="ppm"
          metric="co2"
        />
        <AirQualityCard
          title="PM2.5"
          icon={<CircleDot className="w-full h-full" />}
          iconColor="red"
          value={air?.pm25}
          unit="µg/m³"
          metric="pm25"
        />
        <AirQualityCard
          title="PM10"
          icon={<CircleDot className="w-full h-full" />}
          iconColor="orange"
          value={air?.pm10}
          unit="µg/m³"
          metric="pm10"
        />
        <AirQualityCard
          title="tVOC"
          icon={<Cloud className="w-full h-full" />}
          iconColor="purple"
          value={air?.tvoc}
          unit="index"
          metric="tvoc"
        />
      </div>
    </section>
  );
}
