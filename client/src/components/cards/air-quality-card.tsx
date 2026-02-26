import type { ReactNode } from "react";
import { MetricCard } from "@/components/ui/metric-card";
import { CardTop } from "@/components/ui/card-top";
import { useFlash } from "@/hooks/use-flash";
import { getStatus } from "@/constants/thresholds";
import { cn } from "@/lib/utils";

const statusLevelColors: Record<string, string> = {
  good: "text-green",
  moderate: "text-yellow",
  poor: "text-red",
};

interface AirQualityCardProps {
  title: string | ReactNode;
  icon: ReactNode;
  iconColor: string;
  value: number | null | undefined;
  unit: string;
  metric: string;
}

export function AirQualityCard({
  title,
  icon,
  iconColor,
  value,
  unit,
  metric,
}: AirQualityCardProps) {
  const flash = useFlash(value);
  const status = getStatus(metric, value);

  return (
    <MetricCard level={status.level} flash={!status.level && flash}>
      <CardTop icon={icon} iconColor={iconColor} title={title} />
      <div className="flex-1 flex items-center justify-center py-2">
        <span className="text-5xl font-bold leading-none tracking-tight">
          {value ?? "--"}
        </span>
        <span className="text-[0.9rem] font-normal text-dim ml-0.5">{unit}</span>
      </div>
      <div
        className={cn(
          "text-center text-[0.8rem] font-semibold pb-0.5 min-h-[1.2em]",
          status.level ? statusLevelColors[status.level] : "text-dim"
        )}
      >
        {status.label}
      </div>
    </MetricCard>
  );
}
