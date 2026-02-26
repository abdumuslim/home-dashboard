import { Wind } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";
import { CardTop } from "@/components/ui/card-top";
import { degDir } from "@/constants/thresholds";

interface WindCardProps {
  speed: number | null | undefined;
  gust: number | null | undefined;
  dir: number | null | undefined;
}

export function WindCard({ speed, gust, dir }: WindCardProps) {
  return (
    <MetricCard>
      <CardTop
        icon={<Wind className="w-full h-full" />}
        iconColor="blue"
        title="Wind"
      />
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="wind-circle">
          <div
            className="wind-direction-indicator"
            style={{ transform: dir != null ? `rotate(${dir}deg)` : undefined }}
          >
            <div className="indicator-arrow" />
          </div>
          <span className="text-3xl leading-none font-light z-2">
            {speed != null ? speed.toFixed(1) : "--"}
          </span>
          <span className="text-[0.7rem] text-[#aaa] mt-0.5 z-2">km/h</span>
        </div>
        <div className="flex justify-between w-full mt-2 px-1">
          <div className="flex flex-col">
            <span className="text-[0.75rem] text-[#aaa]">From</span>
            <span className="text-base text-cyan font-medium mt-0.5">{degDir(dir)}</span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[0.75rem] text-[#aaa]">Gusts</span>
            <span className="text-base text-cyan font-medium mt-0.5">
              {gust != null ? gust.toFixed(1) : "--"}{" "}
              <span className="text-[0.7rem] text-[#ccc]">km/h</span>
            </span>
          </div>
        </div>
      </div>
    </MetricCard>
  );
}
