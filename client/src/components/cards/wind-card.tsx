import { useMemo } from "react";
import { Line } from "react-chartjs-2";
import { Maximize2 } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";
import { degDir } from "@/constants/thresholds";
import { getBucketMs, bucketMedian, bucketAverage, expandedChartOptions } from "@/constants/chart-utils";
import type { WeatherReading, OpenOverlayFn, TimeRange } from "@/types/api";

interface WindCardProps {
  speed: number | null | undefined;
  gust: number | null | undefined;
  maxDailyGust?: number | null | undefined;
  dir: number | null | undefined;
  weatherHistory?: WeatherReading[];
  openOverlay: OpenOverlayFn;
}

function ExpandedWindChart({ range, weatherHistory }: { range: TimeRange; weatherHistory: WeatherReading[] }) {
  const bMs = getBucketMs(range);
  const speedData = useMemo(() => bucketMedian(weatherHistory, "wind_speed_kmh", bMs), [weatherHistory, bMs]);
  const gustData = useMemo(() => bucketAverage(weatherHistory, "wind_gust_kmh", bMs), [weatherHistory, bMs]);

  const data = {
    datasets: [
      {
        label: "Speed (median, km/h)",
        data: speedData,
        borderColor: "#f59e0b",
        backgroundColor: "rgba(245, 158, 11, 0.1)",
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
      },
      {
        label: "Gust (km/h)",
        data: gustData,
        borderColor: "rgba(245, 158, 11, 0.4)",
        backgroundColor: "transparent",
        fill: false,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
        borderDash: [4, 4],
      },
    ],
  };

  const options = {
    ...expandedChartOptions(range, "km/h"),
    plugins: {
      ...expandedChartOptions(range, "km/h").plugins,
      legend: { display: true, labels: { color: "#7a8ba8", boxWidth: 12, padding: 16 } },
    },
  };

  return <div className="h-full"><Line data={data} options={options} /></div>;
}

export function WindCard({ speed, gust, maxDailyGust, dir, weatherHistory = [], openOverlay }: WindCardProps) {
  const getMedianSpeed = (history: WeatherReading[], timestamp: number, windowMs: number = 600000) => {
    const windowPoints = history.filter(
      (r) => r.wind_speed_kmh != null && new Date(r.ts).getTime() >= timestamp - windowMs && new Date(r.ts).getTime() <= timestamp
    );
    if (windowPoints.length === 0) return null;
    const speeds = windowPoints.map((r) => r.wind_speed_kmh as number).sort((a, b) => a - b);
    const mid = Math.floor(speeds.length / 2);
    return speeds.length % 2 !== 0 ? speeds[mid] : (speeds[mid - 1] + speeds[mid]) / 2;
  };

  const snapDir = (deg: number) => Math.round(deg / 22.5) * 22.5 % 360;

  const getMeanDir = (history: WeatherReading[], timestamp: number, windowMs: number = 600000) => {
    const points = history.filter(
      (r) => r.wind_dir != null && new Date(r.ts).getTime() >= timestamp - windowMs && new Date(r.ts).getTime() <= timestamp
    );
    if (points.length === 0) return null;
    let sinSum = 0, cosSum = 0;
    for (const r of points) {
      const rad = (r.wind_dir as number) * Math.PI / 180;
      sinSum += Math.sin(rad);
      cosSum += Math.cos(rad);
    }
    const mean = Math.atan2(sinSum, cosSum) * 180 / Math.PI;
    return snapDir(((mean % 360) + 360) % 360);
  };

  const latestTs = weatherHistory.length > 0
    ? new Date(weatherHistory[weatherHistory.length - 1].ts).getTime()
    : 0;
  const currentMedian = weatherHistory.length > 0 ? getMedianSpeed(weatherHistory, latestTs) : null;
  const medianDir = weatherHistory.length > 0 ? getMeanDir(weatherHistory, latestTs) : null;

  const chartDataPoints = (() => {
    const readings = weatherHistory.filter((r) => r.wind_speed_kmh != null);
    if (readings.length === 0) return [];
    const bucketMs = 30 * 60 * 1000;
    const buckets = new Map<number, number[]>();
    for (const r of readings) {
      const ts = new Date(r.ts).getTime();
      const bucketTs = Math.floor(ts / bucketMs) * bucketMs;
      const arr = buckets.get(bucketTs) || [];
      arr.push(r.wind_speed_kmh as number);
      buckets.set(bucketTs, arr);
    }
    return Array.from(buckets.entries())
      .map(([ts, speeds]) => {
        speeds.sort((a, b) => a - b);
        const mid = Math.floor(speeds.length / 2);
        const median = speeds.length % 2 !== 0 ? speeds[mid] : (speeds[mid - 1] + speeds[mid]) / 2;
        return { x: new Date(ts).toISOString(), y: median };
      })
      .sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());
  })();

  const chartData = {
    datasets: [
      {
        data: chartDataPoints,
        borderColor: "#f59e0b",
        backgroundColor: "rgba(245, 158, 11, 0.15)",
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
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

  const handleExpand = () => {
    openOverlay("Wind", (range, wh) => (
      <ExpandedWindChart range={range} weatherHistory={wh} />
    ));
  };

  return (
    <MetricCard className="p-4 pb-0 flex flex-col">
      <div className="flex flex-col z-10 w-full mb-[100px]">
        <h3 className="text-[0.95rem] font-medium text-text mb-2">Wind</h3>

        <div className="flex items-start gap-6 mb-2">
          <div className="flex flex-col">
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-semibold leading-none text-cyan tracking-tight">
                {speed != null ? speed.toFixed(1) : "--"}
              </span>
              <span className="text-sm text-dim">km/h</span>
            </div>
            <span className="text-[0.75rem] text-text font-medium mt-1">Speed</span>
          </div>

          <div className="flex flex-col">
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-semibold leading-none tracking-tight" style={{ color: "#f59e0b" }}>
                {currentMedian != null ? currentMedian.toFixed(1) : "--"}
              </span>
              <span className="text-sm text-dim">km/h</span>
            </div>
            <span className="text-[0.75rem] text-text font-medium mt-1">10Min Med</span>
          </div>

          <div className="relative w-[72px] h-[72px] rounded-full border-2 border-[#1e2f50] flex flex-col items-center justify-center bg-transparent shrink-0 ml-auto">
            <span className="text-sm font-medium text-cyan z-10">{degDir(dir)}</span>

            <div
              className="absolute inset-0 transition-transform duration-700 pointer-events-none"
              style={{ transform: dir != null ? `rotate(${snapDir(dir)}deg)` : undefined }}
            >
              <svg
                className="absolute -top-[10px] left-1/2 -translate-x-1/2 w-[12px] h-[20px] text-cyan drop-shadow-md rotate-180"
                viewBox="0 0 16 24"
                fill="currentColor"
              >
                <path d="M8 0L16 24L8 18L0 24Z" />
              </svg>
            </div>

            <div
              className="absolute inset-0 transition-transform duration-700 pointer-events-none z-[1]"
              style={{ transform: medianDir != null ? `rotate(${medianDir}deg)` : undefined }}
            >
              <svg
                className="absolute -top-[13px] left-1/2 -translate-x-1/2 w-[14px] h-[24px] drop-shadow-md rotate-180"
                viewBox="0 0 16 24"
                fill="none"
                stroke="#f59e0b"
                strokeWidth="2.5"
                strokeLinejoin="round"
              >
                <path d="M8 0L16 24L8 18L0 24Z" />
              </svg>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim -mt-[17px]">
          <span>Gust <span className="text-text font-medium">{gust != null ? gust.toFixed(1) : "--"} km/h</span></span>
          <span>Max <span className="text-text font-medium">{maxDailyGust != null ? maxDailyGust.toFixed(1) : "--"} km/h</span></span>
        </div>
      </div>

      <div
        className="absolute bottom-0 left-0 right-0 h-[100px] w-full px-2 pb-1 z-0 rounded-b-xl overflow-hidden group cursor-pointer"
        onClick={handleExpand}
      >
        <div className="absolute top-1 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
          <Maximize2 className="w-3.5 h-3.5 text-dim" />
        </div>
        {weatherHistory.length > 0 && <Line data={chartData} options={chartOptions} />}
      </div>
    </MetricCard>
  );
}
