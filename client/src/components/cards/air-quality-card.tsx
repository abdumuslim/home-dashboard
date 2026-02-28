import { useMemo, type ReactNode } from "react";
import { Bar } from "react-chartjs-2";
import { Maximize2 } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";
import { useFlash } from "@/hooks/use-flash";
import { fmt, getStatus } from "@/constants/thresholds";
import { getBucketMs, expandedChartOptions } from "@/constants/chart-utils";
import type { AirReading, OpenOverlayFn, TimeRange } from "@/types/api";

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
  extreme: "#9333ea",
};

interface AirQualityCardProps {
  title: string | ReactNode;
  value: number | null | undefined;
  unit: string;
  metric: string;
  airHistory?: AirReading[];
  openOverlay: OpenOverlayFn;
}

function bucketData(history: AirReading[], metricKey: keyof AirReading, bucketMs: number = 1800000) {
  const buckets = new Map<number, { sum: number; count: number }>();
  history.forEach((r) => {
    const val = r[metricKey];
    if (val == null) return;
    const ts = new Date(r.ts).getTime();
    const bucketTs = Math.floor(ts / bucketMs) * bucketMs;
    const existing = buckets.get(bucketTs) || { sum: 0, count: 0 };
    buckets.set(bucketTs, { sum: existing.sum + (val as number), count: existing.count + 1 });
  });
  return Array.from(buckets.entries())
    .map(([ts, data]) => ({ x: new Date(ts).toISOString(), y: data.sum / data.count }))
    .sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());
}

function ExpandedAQChart({ range, airHistory, metric, unit }: { range: TimeRange; airHistory: AirReading[]; metric: string; unit: string }) {
  const bMs = getBucketMs(range);
  const data = useMemo(() => bucketData(airHistory, metric as keyof AirReading, bMs), [airHistory, metric, bMs]);

  const yMax = useMemo(() => {
    if (data.length === 0) return undefined;
    const sorted = data.map((r) => r.y).sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const dataMax = sorted[sorted.length - 1];
    if (dataMax > p90 * 1.5) return Math.ceil(p90 * 1.3);
    return undefined;
  }, [data]);

  const chartData = useMemo(() => ({
    datasets: [
      {
        data,
        backgroundColor: data.map((r) => {
          const s = getStatus(metric, r.y);
          return s.level ? levelColors[s.level] : "#7a8ba8";
        }),
        borderRadius: 2,
        barThickness: range === "6h" ? 6 : range === "24h" ? 4 : 3,
      },
    ],
  }), [data, metric, range]);

  const base = expandedChartOptions(range, unit);
  const options = {
    ...base,
    plugins: {
      ...base.plugins,
      tooltip: {
        ...base.plugins.tooltip,
        callbacks: {
          label: (ctx: { parsed: { y: number | null } }) => {
            const v = ctx.parsed.y ?? 0;
            const s = getStatus(metric, v);
            return `${v.toFixed(1)} ${unit} — ${s.label}`;
          },
        },
      },
    },
    scales: {
      ...base.scales,
      x: { ...base.scales.x, offset: true },
      y: {
        ...base.scales.y,
        beginAtZero: true,
        max: yMax,
      },
    },
  };

  return <div className="h-full"><Bar data={chartData} options={options} /></div>;
}

// Map metric name to a plain-string overlay title
const METRIC_TITLES: Record<string, string> = {
  pm25: "PM2.5",
  pm10: "PM10",
  tvoc: "tVOC",
  co2: "CO\u2082",
};

export function AirQualityCard({
  title,
  value,
  unit,
  metric,
  airHistory = [],
  openOverlay,
}: AirQualityCardProps) {
  const flash = useFlash(value != null ? value : null);
  const status = getStatus(metric, value);
  const activeColor = status.level ? levelColors[status.level] : "#7a8ba8";

  const aggregatedHistory = useMemo(
    () => bucketData(airHistory, metric as keyof AirReading),
    [airHistory, metric],
  );

  const { hi, lo } = useMemo(() => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const key = metric as keyof AirReading;
    const today = airHistory.filter((r) => r[key] != null && new Date(r.ts) >= midnight);
    if (today.length === 0) return { hi: null, lo: null };
    const vals = today.map((r) => r[key] as number);
    return { hi: Math.max(...vals), lo: Math.min(...vals) };
  }, [airHistory, metric]);

  const yMax = useMemo(() => {
    if (aggregatedHistory.length === 0) return undefined;
    const sorted = aggregatedHistory.map((r) => r.y).sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const dataMax = sorted[sorted.length - 1];
    if (dataMax > p90 * 1.5) return Math.ceil(p90 * 1.3);
    return undefined;
  }, [aggregatedHistory]);

  const chartData = useMemo(() => ({
    datasets: [
      {
        data: aggregatedHistory,
        backgroundColor: aggregatedHistory.map((r) => {
          const s = getStatus(metric, r.y);
          return s.level ? levelColors[s.level] : "#7a8ba8";
        }),
        borderRadius: 1,
        barThickness: 2,
      },
    ],
  }), [aggregatedHistory, metric]);

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
        offset: true,
      },
      y: {
        display: true,
        position: "left" as const,
        beginAtZero: true,
        max: yMax,
        grid: { color: "rgba(255,255,255,0.05)" },
        ticks: { color: "#7a8ba8", font: { size: 10 }, maxTicksLimit: 4 },
      },
    },
    elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 4 } },
    interaction: { intersect: false, mode: "index" as const },
  };

  const handleExpand = () => {
    openOverlay(METRIC_TITLES[metric] || metric, (_range, _wh, ah) => (
      <ExpandedAQChart range={_range} airHistory={ah} metric={metric} unit={unit} />
    ));
  };

  return (
    <MetricCard flash={flash} className="p-4 pb-0 flex flex-col !min-h-[200px]">
      <div className="flex items-center gap-5 z-10 w-full mb-[70px]">
        <div className="relative shrink-0 w-[80px] h-[80px] flex justify-center items-center">
          <svg width="80" height="80" viewBox="0 0 80 80" className="absolute inset-0">
            <circle cx="40" cy="40" r="36" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.06)" strokeWidth="4" />
            <circle cx="40" cy="40" r="36" fill="transparent" stroke={activeColor} strokeWidth="4" />
          </svg>
          <div className="flex flex-col items-center justify-center z-10 w-full text-center px-1 mt-1">
            <span className="text-xl font-semibold leading-none text-white tracking-tight">
              {value ?? "--"}
            </span>
            <span className="text-[0.6rem] font-medium text-dim mt-0.5">{unit}</span>
          </div>
        </div>

        <div className="flex flex-col flex-1 justify-center max-w-full overflow-hidden">
          <h3 className="text-[0.95rem] font-medium text-text mb-2 truncate">{title}</h3>
          <div className="text-[0.95rem] font-semibold truncate" style={{ color: activeColor }}>
            {status.label}
          </div>
        </div>

        {hi != null && lo != null && (
          <div className="flex flex-col items-end shrink-0 text-xs text-dim gap-0.5">
            <span><span className="text-red-400">&uarr;</span> <span className="text-text font-medium">{fmt(hi, 0)}</span></span>
            <span><span className="text-blue-400">&darr;</span> <span className="text-text font-medium">{fmt(lo, 0)}</span></span>
          </div>
        )}
      </div>

      <div
        className="absolute bottom-0 left-0 right-0 h-[100px] w-full px-2 pb-1 z-0 rounded-b-xl overflow-hidden group cursor-pointer"
        onClick={handleExpand}
      >
        <div className="absolute top-1 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
          <Maximize2 className="w-3.5 h-3.5 text-dim" />
        </div>
        {aggregatedHistory.length > 0 && <Bar data={chartData} options={chartOptions} />}
      </div>
    </MetricCard>
  );
}
