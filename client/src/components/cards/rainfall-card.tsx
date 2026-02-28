import { Bar } from "react-chartjs-2";
import { MetricCard } from "@/components/ui/metric-card";
import { fmt } from "@/constants/thresholds";
import type { WeatherReading } from "@/types/api";

interface RainfallCardProps {
  hourly: number | null | undefined;
  daily: number | null | undefined;
  monthly: number | null | undefined;
  pressure?: number | null | undefined;
  weatherHistory?: WeatherReading[];
}

export function RainfallCard({ hourly, daily, monthly, weatherHistory = [] }: RainfallCardProps) {
  const chartData = {
    datasets: [
      {
        data: weatherHistory
          .filter((r) => r.rain_hourly_mm != null)
          .map((r) => ({ x: r.ts, y: r.rain_hourly_mm as number })),
        backgroundColor: "#00d4ff",
        borderRadius: 2,
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
        ticks: { color: "#7a8ba8", font: { size: 10 }, stepSize: 1 },
      },
    },
  };

  return (
    <MetricCard className="p-4 pb-0 flex flex-col justify-between">
      <div className="flex flex-col mb-2 z-10 w-full">
        <h3 className="text-[0.95rem] font-medium text-text mb-2">Rainfall</h3>

        <div className="flex items-start gap-4">
          <div className="flex flex-col">
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-semibold leading-none text-cyan tracking-tight">
                {fmt(hourly, 1)}
              </span>
              <span className="text-[0.9rem] font-medium text-text">mm/hr</span>
            </div>
            <span className="text-[0.75rem] text-text mt-1">Rate</span>
          </div>

          <div className="flex gap-4 ml-auto pt-1">
            <div className="flex flex-col text-center">
              <span className="text-xl font-medium leading-none text-white">
                {fmt(daily, 1)}
              </span>
              <span className="text-[0.75rem] text-text mt-1">Day</span>
            </div>

            <div className="flex flex-col text-center">
              <span className="text-xl font-medium leading-none text-white">
                {fmt(monthly, 1)}
              </span>
              <span className="text-[0.75rem] text-text mt-1">Month</span>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-[80px] w-full mt-auto px-2 pb-2">
        {weatherHistory.length > 0 && <Bar data={chartData} options={chartOptions} />}
      </div>
    </MetricCard>
  );
}
