import { useMemo } from "react";
import { Chart } from "react-chartjs-2";
import { MetricCard } from "@/components/ui/metric-card";
import { fmt } from "@/constants/thresholds";
import type { WeatherReading } from "@/types/api";

interface RainfallCardProps {
  hourly: number | null | undefined;
  event: number | null | undefined;
  daily: number | null | undefined;
  weekly: number | null | undefined;
  monthly: number | null | undefined;
  yearly: number | null | undefined;
  lastRain: string | null | undefined;
  pressure: number | null | undefined;
  weatherHistory?: WeatherReading[];
}

function RainDrop({ rate }: { rate: number | null | undefined }) {
  // Fill 0-100% based on 0-10 mm/hr (heavy rain = full)
  const fillPct = rate != null && rate > 0 ? Math.min(rate / 10, 1) : 0;
  const h = 28;
  const fillY = h * (1 - fillPct);

  return (
    <svg width="22" height="32" viewBox="0 0 20 28" className="flex-shrink-0 self-center">
      <defs>
        <clipPath id="rain-drop-clip">
          <path d="M10 1C10 1 1 11 1 17c0 5.5 4 9 9 9s9-3.5 9-9C19 11 10 1 10 1z" />
        </clipPath>
      </defs>
      <path
        d="M10 1C10 1 1 11 1 17c0 5.5 4 9 9 9s9-3.5 9-9C19 11 10 1 10 1z"
        fill="none" stroke="#2196ff" strokeWidth="2.5"
      />
      <rect
        x="0" y={fillY} width="20" height={h - fillY}
        fill="#2196ff" opacity="0.6"
        clipPath="url(#rain-drop-clip)"
      />
    </svg>
  );
}

function formatLastRain(iso: string | null | undefined): string {
  if (!iso) return "--";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "--";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(diff / 3600000);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(diff / 86400000);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function RainfallCard({
  hourly, event, daily, weekly, monthly, yearly,
  lastRain, pressure, weatherHistory = [],
}: RainfallCardProps) {
  // 3-hour pressure trend
  const baroTrend = useMemo(() => {
    const now = Date.now();
    const threeHoursAgo = now - 3 * 3600000;
    const recent = weatherHistory.filter((r) => r.pressure_rel_hpa != null);
    if (recent.length < 2) return null;
    const latest = recent[recent.length - 1].pressure_rel_hpa as number;
    const older = recent.reduce((closest, r) => {
      const dt = Math.abs(new Date(r.ts).getTime() - threeHoursAgo);
      return dt < closest.dt ? { dt, val: r.pressure_rel_hpa as number } : closest;
    }, { dt: Infinity, val: 0 });
    if (older.dt === Infinity) return null;
    const diff = latest - older.val;
    const arrow = diff > 1 ? "\u2191" : diff < -1 ? "\u2193" : "\u2192";
    const color = diff > 1 ? "#4ade80" : diff < -1 ? "#f87171" : "#7a8ba8";
    return { arrow, diff, color };
  }, [weatherHistory]);

  // Downsample pressure to hourly averages for smooth chart
  const hourlyPressure = useMemo(() => {
    const buckets = new Map<number, { sum: number; count: number }>();
    for (const r of weatherHistory) {
      if (r.pressure_rel_hpa == null) continue;
      const ts = new Date(r.ts).getTime();
      const bucketTs = Math.floor(ts / 3600000) * 3600000;
      const existing = buckets.get(bucketTs) || { sum: 0, count: 0 };
      buckets.set(bucketTs, { sum: existing.sum + (r.pressure_rel_hpa as number), count: existing.count + 1 });
    }
    return Array.from(buckets.entries())
      .map(([ts, d]) => ({ x: new Date(ts).toISOString(), y: d.sum / d.count }))
      .sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());
  }, [weatherHistory]);

  // Rain rate data — hourly bucketed to align with pressure
  const rainData = useMemo(() => {
    const buckets = new Map<number, { sum: number; count: number }>();
    for (const r of weatherHistory) {
      if (r.rain_hourly_mm == null) continue;
      const ts = new Date(r.ts).getTime();
      const bucketTs = Math.floor(ts / 3600000) * 3600000;
      const existing = buckets.get(bucketTs) || { sum: 0, count: 0 };
      buckets.set(bucketTs, { sum: existing.sum + (r.rain_hourly_mm as number), count: existing.count + 1 });
    }
    return Array.from(buckets.entries())
      .map(([ts, d]) => ({ x: new Date(ts).toISOString(), y: d.sum / d.count }))
      .sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());
  }, [weatherHistory]);

  const hasRain = rainData.some((d) => d.y > 0);

  const chartData = {
    datasets: [
      {
        type: "line" as const,
        data: hourlyPressure,
        borderColor: "#10b981",
        backgroundColor: "rgba(16, 185, 129, 0.15)",
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
        yAxisID: "y",
      },
      ...(hasRain ? [{
        type: "line" as const,
        data: rainData,
        borderColor: "#2196ff",
        backgroundColor: "rgba(33, 150, 246, 0.15)",
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
        yAxisID: "y2",
      }] : []),
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
        grace: "5%",
      },
      y2: {
        display: hasRain,
        position: "right" as const,
        min: 0,
        suggestedMax: 1,
        grid: { drawOnChartArea: false },
        ticks: { color: "#2196ff", font: { size: 10 }, stepSize: 1 },
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
    <MetricCard className="p-4 pb-0 flex flex-col">
      <div className="flex flex-col z-10 w-full mb-[100px]">
        <h3 className="text-[0.95rem] font-medium text-text mb-2">Rainfall</h3>

        <div className="flex items-end gap-8 mb-2">
          <div className="flex flex-col">
            <div className="flex items-end gap-1.5">
              <RainDrop rate={hourly} />
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-semibold leading-none text-cyan tracking-tight">
                  {fmt(hourly, 1)}
                </span>
                <span className="text-sm text-dim">mm/hr</span>
              </div>
            </div>
            <span className="text-[0.75rem] text-text font-medium mt-1">Rate</span>
          </div>

          <div className="flex flex-col">
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-semibold leading-none tracking-tight" style={{ color: "#10b981" }}>
                {fmt(pressure, 1)}
              </span>
              <span className="text-sm text-dim">hPa</span>
              {baroTrend && (
                <span className="text-sm font-medium" style={{ color: baroTrend.color }}>{baroTrend.arrow}{Math.abs(baroTrend.diff).toFixed(1)}</span>
              )}
            </div>
            <span className="text-[0.75rem] text-text font-medium mt-1">Barometer</span>
          </div>
        </div>

        <div className="flex items-center gap-x-2 text-xs text-dim">
          <span>Ev <span className="text-text font-medium">{fmt(event, 1)}</span></span>
          <span>Day <span className="text-text font-medium">{fmt(daily, 1)}</span></span>
          <span>Wk <span className="text-text font-medium">{fmt(weekly, 1)}</span></span>
          <span>Mo <span className="text-text font-medium">{fmt(monthly, 1)}</span></span>
          <span>Yr <span className="text-text font-medium">{fmt(yearly, 1)}</span></span>
          <span>Last <span className="text-text font-medium">{formatLastRain(lastRain)}</span></span>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-[100px] w-full px-2 pb-1 z-0 rounded-b-xl overflow-hidden">
        {hourlyPressure.length > 0 && <Chart type="line" data={chartData} options={chartOptions} />}
      </div>
    </MetricCard>
  );
}
