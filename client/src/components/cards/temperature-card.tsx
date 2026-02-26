import { Thermometer } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";
import { CardTop } from "@/components/ui/card-top";
import { useFlash } from "@/hooks/use-flash";
import { fmt } from "@/constants/thresholds";

interface TemperatureCardProps {
  temp: number | null | undefined;
  humidity: number | null | undefined;
  dewPoint: number | null | undefined;
  feelsLike: number | null | undefined;
}

export function TemperatureCard({ temp, humidity, dewPoint, feelsLike }: TemperatureCardProps) {
  const flash = useFlash(temp != null ? fmt(temp, 1) : null);

  return (
    <MetricCard flash={flash}>
      <CardTop
        icon={<Thermometer className="w-full h-full" />}
        iconColor="cyan"
        title="Temperature"
      />
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="flex items-baseline gap-0.5">
          <span className="text-5xl font-bold leading-none tracking-tight">{fmt(temp, 1)}</span>
          <span className="text-lg font-normal text-dim">&deg;</span>
        </div>
        <div className="flex items-baseline gap-0.5 mt-1">
          <span className="text-2xl font-semibold leading-none text-dim">{fmt(humidity, 0)}</span>
          <span className="text-sm font-normal text-dim">%</span>
        </div>
      </div>
      <div className="flex justify-center gap-4">
        <div className="text-center">
          <span className="block text-[0.6rem] text-dim">Dew Point</span>
          <span className="block text-[0.75rem] font-semibold text-cyan">{fmt(dewPoint, 1)}&deg;C</span>
        </div>
        <div className="text-center">
          <span className="block text-[0.6rem] text-dim">Feels Like</span>
          <span className="block text-[0.75rem] font-semibold text-cyan">{fmt(feelsLike, 1)}&deg;C</span>
        </div>
      </div>
    </MetricCard>
  );
}
