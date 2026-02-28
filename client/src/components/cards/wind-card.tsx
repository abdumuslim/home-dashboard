import { Line } from "react-chartjs-2";
import { MetricCard } from "@/components/ui/metric-card";
import { degDir } from "@/constants/thresholds";
import type { WeatherReading } from "@/types/api";

interface WindCardProps {
  speed: number | null | undefined;
  gust: number | null | undefined;
  maxDailyGust?: number | null | undefined;
  dir: number | null | undefined;
  weatherHistory?: WeatherReading[];
}

export function WindCard({ speed, gust, maxDailyGust, dir, weatherHistory = [] }: WindCardProps) {
  // Calculate 10-minute median for raw speed values
  const getMedianSpeed = (history: WeatherReading[], timestamp: number, windowMs: number = 600000) => {
    const windowPoints = history.filter(
      (r) => r.wind_speed_kmh != null && Math.abs(new Date(r.ts).getTime() - timestamp) <= windowMs / 2
    );
    if (windowPoints.length === 0) return null;

    const speeds = windowPoints.map((r) => r.wind_speed_kmh as number).sort((a, b) => a - b);
    const mid = Math.floor(speeds.length / 2);

    return speeds.length % 2 !== 0
      ? speeds[mid]
      : (speeds[mid - 1] + speeds[mid]) / 2;
  };

  // Pre-compute current median for display
  const currentMedian = weatherHistory.length > 0
    ? getMedianSpeed(weatherHistory, new Date(weatherHistory[0].ts).getTime())
    : null;

  // Generate chart data using 10-min median
  const chartDataPoints = weatherHistory
    .filter((r) => r.wind_speed_kmh != null)
    .map((r) => {
      const ts = new Date(r.ts).getTime();
      const median = getMedianSpeed(weatherHistory, ts);
      return { x: r.ts, y: median };
    })
    .filter((p) => p.y !== null) as { x: string; y: number }[];

  const chartData = {
    datasets: [
      {
        data: chartDataPoints,
        borderColor: "#00d4ff",
        backgroundColor: "rgba(0, 212, 255, 0.2)",
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
        ticks: { color: "#7a8ba8", font: { size: 10 }, stepSize: 5 },
      },
    },
  };

  return (
    <MetricCard className="p-4 pb-0 flex flex-col justify-between">
      <div className="flex flex-col mb-2 z-10 w-full">
        <h3 className="text-[0.95rem] font-medium text-text mb-2">Wind</h3>

        <div className="flex items-center gap-4">
          <div className="relative w-[60px] h-[60px] rounded-full border-2 border-[#1e2f50] flex flex-col items-center justify-center bg-transparent shrink-0">
            <span className="absolute top-0.5 text-[0.55rem] text-dim">N</span>
            <span className="absolute bottom-0.5 text-[0.55rem] text-dim">S</span>
            <span className="absolute left-1 text-[0.55rem] text-dim">W</span>
            <span className="absolute right-1 text-[0.55rem] text-dim">E</span>

            <div
              className="absolute inset-0 transition-transform duration-700 pointer-events-none"
              style={{ transform: dir != null ? `rotate(${dir}deg)` : undefined }}
            >
              <svg
                className="absolute -top-[9px] left-1/2 -translate-x-1/2 w-[14px] h-[18px] text-cyan drop-shadow-md rotate-180"
                viewBox="0 0 24 24"
                fill="currentColor"
                preserveAspectRatio="none"
              >
                <path d="M12 0L24 24L12 17L0 24Z" />
              </svg>
            </div>
          </div>

          <div className="flex flex-col flex-1">
            <div className="flex items-end justify-between gap-1 w-full">
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-semibold leading-none text-cyan tracking-tight">
                  {speed != null ? speed.toFixed(1) : "--"}
                </span>
                <span className="text-[0.9rem] font-medium text-dim">km/h</span>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-[0.65rem] text-dim uppercase tracking-wider mb-0.5 leading-none">10m Median</span>
                <div className="flex items-baseline gap-0.5">
                  <span className="text-xl font-medium leading-none text-white tracking-tight">
                    {currentMedian != null ? currentMedian.toFixed(1) : "--"}
                  </span>
                  <span className="text-[0.7rem] font-medium text-dim">km/h</span>
                </div>
              </div>
            </div>
            <div className="text-[0.8rem] text-text font-medium mt-1">
              From {degDir(dir)}
            </div>
            <div className="text-[0.75rem] text-text mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span>Gusts {gust != null ? gust.toFixed(1) : "--"} <span className="text-dim">km/h</span></span>
              <span className="text-dim text-[0.5rem]">•</span>
              <span>Max {maxDailyGust != null ? maxDailyGust.toFixed(1) : "--"} <span className="text-dim">km/h</span></span>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-[100px] w-full mt-auto px-2 pb-2">
        {weatherHistory.length > 0 && <Line data={chartData} options={chartOptions} />}
      </div>
    </MetricCard>
  );
}
