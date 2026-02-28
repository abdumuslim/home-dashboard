import type { ReactNode } from "react";
import { Line } from "react-chartjs-2";
import { MetricCard } from "@/components/ui/metric-card";
import { useFlash } from "@/hooks/use-flash";
import { fmt, getStatus } from "@/constants/thresholds";
import type { WeatherReading, AirReading } from "@/types/api";

const statusLevelColors: Record<string, string> = {
  excellent: "#0df41e",
  good: "#1bd929",
  normal: "#0df41e",
  low: "#0df41e",
  moderate: "#fbbf24",
  slightly_high: "#fbbf24",
  poor: "#f97316",
  high: "#f97316", // Noise High is Orange based on image
  very_high: "#9f1239",
  severe: "#ef4444",
  extreme: "#9333ea",
};

interface IndoorCardProps {
  title: string;
  icon?: ReactNode;
  iconColor?: string;
  temp: number | null | undefined;
  humidity: number | null | undefined;
  dewPoint?: number | null | undefined;
  feelsLike?: number | null | undefined;
  noise?: number | null | undefined;
  history?: (WeatherReading | AirReading)[];
  metricKey?: keyof WeatherReading | keyof AirReading;
}

export function IndoorCard({
  title,
  temp,
  humidity,
  dewPoint,
  feelsLike,
  noise,
  history = [],
  metricKey,
}: IndoorCardProps) {
  const flash = useFlash(temp != null ? fmt(temp, 1) : null);
  const noiseStatus = noise !== undefined ? getStatus("noise", noise) : null;

  // Downsample history into hourly averages for a smooth chart
  const hourlyData = (() => {
    if (!metricKey) return [];
    const buckets = new Map<number, { sum: number; count: number }>();
    for (const r of history) {
      const val = r[metricKey as keyof typeof r];
      if (val == null) continue;
      const ts = new Date(r.ts).getTime();
      const bucketTs = Math.floor(ts / 3600000) * 3600000;
      const existing = buckets.get(bucketTs) || { sum: 0, count: 0 };
      buckets.set(bucketTs, { sum: existing.sum + (val as number), count: existing.count + 1 });
    }
    return Array.from(buckets.entries())
      .map(([ts, d]) => ({ x: new Date(ts).toISOString(), y: d.sum / d.count }))
      .sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());
  })();

  const chartData = {
    datasets: [
      {
        data: hourlyData,
        borderColor: "#00d4ff",
        backgroundColor: "rgba(0, 212, 255, 0.15)",
        borderWidth: 2,
        fill: true,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
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
        ticks: { color: "#7a8ba8", font: { size: 10 } },
      },
    },
    elements: {
      point: { radius: 0, hitRadius: 10, hoverRadius: 4 },
    },
    interaction: {
      intersect: false,
      mode: "index" as const,
    },
  };

  return (
    <MetricCard flash={flash} className="p-4 pb-0 flex flex-col">
      <div className="flex flex-col z-10 w-full mb-[100px]">
        <h3 className="text-[0.95rem] font-medium text-text mb-2">{title}</h3>

        <div className="flex items-baseline gap-5">
          <div className="flex flex-col">
            <span className="text-3xl font-semibold leading-none tracking-tight text-cyan">
              {fmt(temp, 1)}<span className="text-xl">&deg;C</span>
            </span>
            <span className="text-[0.75rem] text-text font-medium mt-1">Temp.</span>
          </div>

          <div className="flex flex-col">
            <span className="text-3xl font-semibold leading-none tracking-tight text-cyan">
              {fmt(humidity, 0)}<span className="text-xl">%</span>
            </span>
            <span className="text-[0.75rem] text-text font-medium mt-1">Humidity</span>
          </div>

          {dewPoint != null && (
            <div className="flex flex-col ml-auto">
              <span className="text-lg font-semibold leading-none tracking-tight text-[#94a3b8]">
                {fmt(dewPoint, 1)}<span className="text-sm">&deg;C</span>
              </span>
              <span className="text-[0.75rem] text-text font-medium mt-1">Dew Point</span>
            </div>
          )}

          {feelsLike != null && (
            <div className="flex flex-col">
              <span className="text-lg font-semibold leading-none tracking-tight text-[#94a3b8]">
                {fmt(feelsLike, 1)}<span className="text-sm">&deg;C</span>
              </span>
              <span className="text-[0.75rem] text-text font-medium mt-1">Feels Like</span>
            </div>
          )}

          {noise !== undefined && noiseStatus && (
            <div className="flex flex-col ml-auto">
              <span className="text-lg font-semibold leading-none tracking-tight text-[#94a3b8]">
                {noise ?? "--"}<span className="text-sm"> dB</span>
              </span>
              <span
                className="text-[0.75rem] font-medium mt-1"
                style={{ color: noiseStatus.level ? statusLevelColors[noiseStatus.level] : "#7a8ba8" }}
              >
                {noiseStatus.label}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-[100px] w-full px-2 pb-1 z-0 rounded-b-xl overflow-hidden">
        {hourlyData.length > 0 && <Line data={chartData} options={chartOptions} />}
      </div>
    </MetricCard>
  );
}
