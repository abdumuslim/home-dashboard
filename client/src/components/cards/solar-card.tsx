import { Sun } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";
import { CardTop } from "@/components/ui/card-top";
import { useFlash } from "@/hooks/use-flash";
import { fmt, getStatus } from "@/constants/thresholds";
import { cn } from "@/lib/utils";

const uvLevelColors: Record<string, string> = {
  good: "text-green",
  moderate: "text-yellow",
  poor: "text-orange",
  severe: "text-red",
  extreme: "text-purple",
};

interface SolarCardProps {
  radiation: number | null | undefined;
  uvIndex: number | null | undefined;
}

export function SolarCard({ radiation, uvIndex }: SolarCardProps) {
  const flash = useFlash(radiation != null ? fmt(radiation, 0) : null);
  const uvStatus = getStatus("uv", uvIndex);

  return (
    <MetricCard flash={flash}>
      <CardTop
        icon={<Sun className="w-full h-full" />}
        iconColor="yellow"
        title="Solar"
      />
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="flex items-baseline gap-0.5">
          <span className="text-5xl font-bold leading-none tracking-tight">{fmt(radiation, 0)}</span>
          <span className="text-[0.9rem] font-normal text-dim">W/m²</span>
        </div>
      </div>
      <div className="text-center">
        <span className="text-[0.7rem] text-dim">UV </span>
        <span className="text-[0.9rem] font-bold">{uvIndex ?? "--"}</span>
        <span
          className={cn(
            "text-[0.75rem] font-semibold ml-1.5",
            uvStatus.level ? uvLevelColors[uvStatus.level] : "text-dim"
          )}
        >
          {uvStatus.label}
        </span>
      </div>
    </MetricCard>
  );
}
