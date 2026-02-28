import { Line } from "react-chartjs-2";
import { MetricCard } from "@/components/ui/metric-card";
import { useFlash } from "@/hooks/use-flash";
import { fmt, getStatus } from "@/constants/thresholds";
import { cn } from "@/lib/utils";
import type { WeatherReading } from "@/types/api";

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
  weatherHistory?: WeatherReading[];
}

export function SolarCard({ radiation, uvIndex, weatherHistory = [] }: SolarCardProps) {
  const flash = useFlash(radiation != null ? fmt(radiation, 0) : null);
  const uvStatus = getStatus("uv", uvIndex);

  const chartData = {
    datasets: [
      {
        data: weatherHistory
          .filter((r) => r.solar_radiation != null)
          .map((r) => ({ x: r.ts, y: r.solar_radiation as number })),
        borderColor: "#ffc107",
        backgroundColor: "rgba(255, 193, 7, 0.2)",
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { enabled: false },
    },
    scales: {
      x: {
        type: "time" as const,
        time: { unit: "hour" as const, stepSize: 1, displayFormats: { hour: "h" } },
        grid: { display: false },
        ticks: { color: "#7a8ba8", font: { size: 9 }, maxRotation: 0, autoSkip: false, autoSkipPadding: 0, padding: 0 },
      },
      y: {
        display: true,
        position: "left" as const,
        grid: { color: "rgba(255,255,255,0.05)" },
        ticks: { color: "#7a8ba8", font: { size: 10 }, stepSize: 200 },
      },
    },
  };

  return (
    <MetricCard flash={flash} className="p-4 pb-0 flex flex-col justify-between">
      <div className="flex flex-col mb-2 z-10 w-full">
        <h3 className="text-[0.95rem] font-medium text-text mb-2">Solar</h3>

        <div className="flex justify-between items-start">
          <div className="flex flex-col">
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-semibold leading-none text-yellow tracking-tight">
                {fmt(radiation, 0)}
              </span>
              <span className="text-[0.9rem] font-medium text-text">W/m²</span>
            </div>
            <span className="text-[0.8rem] text-text font-medium mt-1">UV</span>
          </div>

          <div className="flex flex-col items-center">
            <span className="text-2xl font-medium leading-none text-white">
              {uvIndex ?? "--"}
            </span>
            <span
              className={cn(
                "text-[0.75rem] font-medium mt-1",
                uvStatus.level ? uvLevelColors[uvStatus.level] : "text-dim"
              )}
            >
              {uvStatus.label}
            </span>
          </div>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-[100px] w-full mt-auto px-2 pb-2">
        {weatherHistory.length > 0 && <Line data={chartData} options={chartOptions} />}
      </div>
    </MetricCard>
  );
}
