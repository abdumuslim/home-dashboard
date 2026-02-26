import { useMemo } from "react";
import { CloudRain } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";
import { CardTop } from "@/components/ui/card-top";
import { fmt } from "@/constants/thresholds";
import { cn } from "@/lib/utils";
import type { WeatherReading } from "@/types/api";

interface RainfallCardProps {
  hourly: number | null | undefined;
  daily: number | null | undefined;
  monthly: number | null | undefined;
  pressure: number | null | undefined;
  weatherHistory: WeatherReading[];
}

export function RainfallCard({ hourly, daily, monthly, pressure, weatherHistory }: RainfallCardProps) {
  const trend = useMemo(() => {
    const hist = weatherHistory
      .filter((r) => r.pressure_rel_hpa != null)
      .map((r) => ({ ts: new Date(r.ts).getTime(), v: r.pressure_rel_hpa! }));

    if (hist.length < 2) return null;

    const now = Date.now();
    const cutoff = now - 3 * 3600000;
    const old = hist.find((p) => p.ts >= cutoff) || hist[0];
    const cur = hist[hist.length - 1];
    const diff = cur.v - old.v;

    if (diff > 1) return { direction: "rising" as const, diff: Math.abs(diff) };
    if (diff < -1) return { direction: "falling" as const, diff: Math.abs(diff) };
    return { direction: "steady" as const, diff: 0 };
  }, [weatherHistory]);

  return (
    <MetricCard>
      <CardTop
        icon={<CloudRain className="w-full h-full" />}
        iconColor="blue"
        title="Rainfall"
      />
      <div className="flex-1 flex justify-around items-center py-2">
        <RainCol value={fmt(hourly, 1)} unit="mm/hr" label="Rate" />
        <RainCol value={fmt(daily, 1)} unit="mm" label="Day" />
        <RainCol value={fmt(monthly, 1)} unit="mm" label="Month" />
      </div>
      <div className="text-center pt-1 border-t border-card-border">
        <span className="text-[0.9rem] font-semibold">{fmt(pressure, 1)}</span>
        <span className="text-[0.7rem] text-dim ml-0.5">hPa</span>
        {trend && (
          <span
            className={cn(
              "text-[0.7rem] font-semibold ml-1.5",
              trend.direction === "rising" && "text-green",
              trend.direction === "falling" && "text-red",
              trend.direction === "steady" && "text-dim"
            )}
          >
            {trend.direction === "rising" && `↑ ${fmt(trend.diff, 1)}`}
            {trend.direction === "falling" && `↓ ${fmt(trend.diff, 1)}`}
            {trend.direction === "steady" && "→ stable"}
          </span>
        )}
      </div>
    </MetricCard>
  );
}

function RainCol({ value, unit, label }: { value: string; unit: string; label: string }) {
  return (
    <div className="text-center">
      <span className="block text-2xl font-bold leading-none">{value}</span>
      <span className="block text-[0.55rem] text-dim my-0.5">{unit}</span>
      <span className="block text-[0.6rem] font-medium text-dim">{label}</span>
    </div>
  );
}
