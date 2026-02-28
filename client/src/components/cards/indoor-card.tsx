import type { ReactNode } from "react";
import { Line } from "react-chartjs-2";
import { fmt, getStatus } from "@/constants/thresholds";
import type { WeatherReading, AirReading } from "@/types/api";
import { cn } from "@/lib/utils";

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
        backgroundColor: "rgba(0, 212, 255, 0.1)",
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
      tooltip: { enabled: false }, // Consider turning on if detail needed
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
      point: {
        radius: 0,
        hitRadius: 10,
        hoverRadius: 4,
      }
    },
    interaction: {
      intersect: false,
      mode: "index" as const,
    },
  };

  // Adjust card min-height to accommodate chart if rendering
  const hasChart = hourlyData.length > 0;

  return (
    <div className={cn("glass-card p-3.5 flex flex-col relative", hasChart ? "min-h-[220px] pb-0" : "justify-between")}>
      <div className="z-10 w-full mb-2">
        <h3 className="text-[0.95rem] font-medium text-text mb-3">{title}</h3>
        <div className="flex justify-between items-end gap-2 text-left">

          <div className="flex flex-col">
            <span className="text-[0.75rem] text-text mb-1">Temp</span>
            <span className="text-xl font-medium tracking-tight text-cyan">
              {fmt(temp, 1)}&deg;C
            </span>
          </div>

          <div className="flex flex-col">
            <span className="text-[0.75rem] text-text mb-1">Humidity</span>
            <span className="text-xl font-medium tracking-tight text-cyan">
              {fmt(humidity, 0)}%
            </span>
          </div>

          {dewPoint != null && (
            <div className="flex flex-col">
              <span className="text-[0.75rem] text-text mb-1">Dew Point</span>
              <span className="text-xl font-medium tracking-tight text-yellow">
                {fmt(dewPoint, 1)}&deg;C
              </span>
            </div>
          )}

          {feelsLike != null && (
            <div className="flex flex-col">
              <span className="text-[0.75rem] text-text mb-1">Feels Like</span>
              <span className="text-xl font-medium tracking-tight text-yellow">
                {fmt(feelsLike, 1)}&deg;C
              </span>
            </div>
          )}

          {noise !== undefined && noiseStatus && (
            <div className="flex flex-col mb-0.5">
              <span className="text-xl font-medium tracking-tight text-white flex items-baseline gap-1">
                {noise ?? "--"} <span className="text-sm font-normal">dB</span>
              </span>
              <span
                className="text-[0.75rem] font-medium"
                style={{ color: noiseStatus.level ? statusLevelColors[noiseStatus.level] : "#7a8ba8" }}
              >
                {noiseStatus.label}
              </span>
            </div>
          )}
        </div>
      </div>

      {hasChart && (
        <div className="absolute bottom-0 left-0 right-0 h-[120px] w-full mt-auto px-2 pb-1 z-0 rounded-b-xl overflow-hidden">
          <Line data={chartData} options={chartOptions} />
        </div>
      )}
    </div>
  );
}
