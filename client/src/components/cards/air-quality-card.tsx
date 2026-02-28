import type { ReactNode } from "react";
import { Bar } from "react-chartjs-2";
import { getStatus } from "@/constants/thresholds";
import type { AirReading } from "@/types/api";

const levelColors: Record<string, string> = {
  excellent: "#0df41e",
  good: "#1bd929",
  normal: "#0df41e",
  low: "#0df41e",
  moderate: "#fbbf24",
  slightly_high: "#fbbf24",
  poor: "#f97316",
  high: "#f97316",
  very_high: "#9f1239",
  severe: "#ef4444",
  extreme: "#9333ea"
};

interface AirQualityCardProps {
  title: string | ReactNode;
  value: number | null | undefined;
  unit: string;
  metric: string;
  airHistory?: AirReading[];
}

// Helper to bucket data into 1-hour intervals and average them
function bucketData(history: AirReading[], metricKey: keyof AirReading) {
  const buckets = new Map<number, { sum: number; count: number }>();

  history.forEach((r) => {
    const val = r[metricKey];
    if (val == null) return;

    // Round down to the nearest hour (60 * 60 * 1000 = 3600000 ms)
    const ts = new Date(r.ts).getTime();
    const bucketTs = Math.floor(ts / 3600000) * 3600000;

    const existing = buckets.get(bucketTs) || { sum: 0, count: 0 };
    buckets.set(bucketTs, {
      sum: existing.sum + (val as number),
      count: existing.count + 1,
    });
  });

  // Convert map back to array and calculate averages
  return Array.from(buckets.entries())
    .map(([ts, data]) => ({
      x: new Date(ts).toISOString(),
      y: data.sum / data.count,
    }))
    .sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());
}

export function AirQualityCard({
  title,
  value,
  unit,
  metric,
  airHistory = [],
}: AirQualityCardProps) {
  const status = getStatus(metric, value);
  const activeColor = status.level ? levelColors[status.level] : "#7a8ba8";

  // Filter valid history and construct chart data
  const aggregatedHistory = bucketData(airHistory, metric as keyof AirReading);

  const chartData = {
    datasets: [
      {
        data: aggregatedHistory,
        backgroundColor: aggregatedHistory.map((r) => {
          const s = getStatus(metric, r.y);
          return s.level ? levelColors[s.level] : "#7a8ba8";
        }),
        borderRadius: 1,
        barThickness: 3,
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
        offset: true,
      },
      y: {
        display: false,
        beginAtZero: true,
      },
    },
  };

  return (
    <div className="glass-card flex flex-col p-4 pb-0 min-h-[200px] relative">
      <div className="flex items-center gap-5 z-10 w-full mb-2">
        <div className="relative shrink-0 w-[80px] h-[80px] flex justify-center items-center">
          <svg width="80" height="80" viewBox="0 0 80 80" className="absolute inset-0">
            <circle
              cx="40"
              cy="40"
              r="36"
              fill="rgba(255,255,255,0.02)"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="4"
            />
            <circle
              cx="40"
              cy="40"
              r="36"
              fill="transparent"
              stroke={activeColor}
              strokeWidth="4"
            />
          </svg>
          <div className="flex flex-col items-center justify-center z-10 w-full text-center px-1">
            <span className="text-xl font-semibold leading-none text-white tracking-tight">
              {value ?? "--"}
            </span>
            <span className="text-[0.6rem] font-medium text-dim mt-0.5">{unit}</span>
          </div>
        </div>

        <div className="flex flex-col flex-1 justify-center max-w-full overflow-hidden">
          <h3 className="text-[1.05rem] font-medium text-text mb-1 truncate">{title}</h3>
          <div
            className="text-[0.95rem] font-semibold truncate"
            style={{ color: activeColor }}
          >
            {status.label}
          </div>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-[85px] w-full mt-auto px-4 pb-3 z-0">
        {aggregatedHistory.length > 0 && <Bar data={chartData} options={chartOptions} />}
      </div>
    </div>
  );
}
