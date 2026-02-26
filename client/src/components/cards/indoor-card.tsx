import type { ReactNode } from "react";
import { MetricCard } from "@/components/ui/metric-card";
import { CardTop } from "@/components/ui/card-top";
import { fmt, getStatus } from "@/constants/thresholds";
import { cn } from "@/lib/utils";

const statusLevelColors: Record<string, string> = {
  good: "text-green",
  moderate: "text-yellow",
  poor: "text-red",
};

interface IndoorCardProps {
  title: string;
  icon: ReactNode;
  iconColor: string;
  temp: number | null | undefined;
  humidity: number | null | undefined;
  dewPoint?: number | null | undefined;
  feelsLike?: number | null | undefined;
  noise?: number | null | undefined;
}

export function IndoorCard({
  title,
  icon,
  iconColor,
  temp,
  humidity,
  dewPoint,
  feelsLike,
  noise,
}: IndoorCardProps) {
  const noiseStatus = noise !== undefined ? getStatus("noise", noise) : null;

  return (
    <MetricCard>
      <CardTop icon={icon} iconColor={iconColor} title={title} />
      <div className="flex justify-around flex-1 py-2 gap-4">
        <div className="text-center">
          <span className="block text-[0.7rem] text-dim mb-1.5">Temperature</span>
          <span className="block text-[1.8rem] font-bold leading-tight">
            {fmt(temp, 1)}&deg;C
          </span>
          {dewPoint != null && (
            <div className="mt-1">
              <span className="text-[0.65rem] text-dim">Dew Point</span>
              <span className="text-[0.75rem] font-semibold text-cyan ml-1">
                {fmt(dewPoint, 1)}&deg;C
              </span>
            </div>
          )}
          {feelsLike != null && (
            <div className="mt-1">
              <span className="text-[0.65rem] text-dim">Feels Like</span>
              <span className="text-[0.75rem] font-semibold text-cyan ml-1">
                {fmt(feelsLike, 1)}&deg;C
              </span>
            </div>
          )}
        </div>
        <div className="text-center">
          <span className="block text-[0.7rem] text-dim mb-1.5">Humidity</span>
          <span className="block text-[1.8rem] font-bold leading-tight">
            {fmt(humidity, 0)}%
          </span>
        </div>
      </div>
      {noise !== undefined && noiseStatus && (
        <div className="text-center pt-1 border-t border-card-border">
          <span className="text-[0.9rem] font-semibold">{noise ?? "--"}</span>
          <span className="text-[0.7rem] text-dim ml-0.5">dB</span>
          <span
            className={cn(
              "text-[0.75rem] font-semibold ml-1.5",
              noiseStatus.level ? statusLevelColors[noiseStatus.level] : "text-dim"
            )}
          >
            {noiseStatus.label}
          </span>
        </div>
      )}
    </MetricCard>
  );
}
