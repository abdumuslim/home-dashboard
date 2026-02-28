import { useMemo, useState, useEffect } from "react";
import { Chart } from "react-chartjs-2";
import { Sun, CloudSun, Cloud } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";
import { useFlash } from "@/hooks/use-flash";
import { fmt, getStatus } from "@/constants/thresholds";
import type { WeatherReading } from "@/types/api";

const UV_COLORS: Record<string, string> = {
  good: "#4ade80",
  moderate: "#fbbf24",
  poor: "#f97316",
  severe: "#ef4444",
  extreme: "#9333ea",
};

interface SolarCardProps {
  radiation: number | null | undefined;
  uvIndex: number | null | undefined;
  weatherHistory?: WeatherReading[];
}

interface SkyResult { label: string; Icon: typeof Sun; color: string }

function getSkyCondition(
  radiation: number | null | undefined,
  refMax: number | null,
  history: WeatherReading[],
): SkyResult | null {
  if (refMax == null || refMax < 10 || radiation == null) return null;

  const level = radiation / refMax;

  // Analyze last 10 min for unexpected drops (instability = clouds)
  const now = Date.now();
  const recent = history
    .filter((r) => r.solar_radiation != null && now - new Date(r.ts).getTime() <= 600000)
    .map((r) => r.solar_radiation as number);

  let dropRatio = 0;
  if (recent.length >= 2) {
    const max10 = Math.max(...recent);
    const min10 = Math.min(...recent);
    dropRatio = (max10 - min10) / refMax; // normalized variability
  }

  // High radiation
  if (level > 0.7) {
    if (dropRatio < 0.1) return { label: "Sunny", Icon: Sun, color: "#ffc107" };
    return { label: "Partly Cloudy", Icon: CloudSun, color: "#fbbf24" };
  }
  // Moderate radiation
  if (level > 0.4) {
    if (dropRatio < 0.1) return { label: "Partly Cloudy", Icon: CloudSun, color: "#fbbf24" };
    return { label: "Mostly Cloudy", Icon: Cloud, color: "#94a3b8" };
  }
  // Low radiation
  if (level > 0.15) return { label: "Mostly Cloudy", Icon: Cloud, color: "#94a3b8" };
  return { label: "Overcast", Icon: Cloud, color: "#64748b" };
}

export function SolarCard({ radiation, uvIndex, weatherHistory = [] }: SolarCardProps) {
  const flashRad = useFlash(radiation != null ? fmt(radiation, 0) : null);
  const flashUV = useFlash(uvIndex != null ? fmt(uvIndex, 0) : null);
  const flash = flashRad || flashUV;
  const uvStatus = getStatus("uv", uvIndex);
  const uvColor = uvStatus.level ? UV_COLORS[uvStatus.level] : "#7a8ba8";

  // Fetch weekly max solar radiation per hour-of-day
  const [hourlyMax, setHourlyMax] = useState<Record<number, number> | null>(null);

  useEffect(() => {
    let mounted = true;
    const fetchRef = async () => {
      try {
        const res = await fetch("/api/solar-reference");
        const data = await res.json();
        if (mounted) setHourlyMax(data.hourly_max);
      } catch { /* ignore */ }
    };
    fetchRef();
    const id = setInterval(fetchRef, 300000); // refresh every 5 min
    return () => { mounted = false; clearInterval(id); };
  }, []);

  const sky = getSkyCondition(
    radiation,
    hourlyMax ? (hourlyMax[new Date().getHours()] ?? null) : null,
    weatherHistory,
  );

  // Today's peak radiation and UV since midnight
  const { peakRadiation, peakUv, peakUvColor } = useMemo(() => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const today = weatherHistory.filter((r) => new Date(r.ts) >= midnight);

    const rads = today.filter((r) => r.solar_radiation != null).map((r) => r.solar_radiation as number);
    const uvs = today.filter((r) => r.uv_index != null).map((r) => r.uv_index as number);

    const peakRad = rads.length > 0 ? Math.max(...rads) : null;
    const peakUvVal = uvs.length > 0 ? Math.max(...uvs) : null;
    const peakUvStatus = getStatus("uv", peakUvVal);

    return {
      peakRadiation: peakRad != null ? fmt(peakRad, 0) : "--",
      peakUv: peakUvVal != null ? fmt(peakUvVal, 0) : "--",
      peakUvColor: peakUvStatus.level ? UV_COLORS[peakUvStatus.level] : "#7a8ba8",
    };
  }, [weatherHistory]);

  // Hourly average solar radiation
  const hourlySolar = useMemo(() => {
    const buckets = new Map<number, { sum: number; count: number }>();
    for (const r of weatherHistory) {
      if (r.solar_radiation == null) continue;
      const ts = new Date(r.ts).getTime();
      const bucketTs = Math.floor(ts / 3600000) * 3600000;
      const existing = buckets.get(bucketTs) || { sum: 0, count: 0 };
      buckets.set(bucketTs, { sum: existing.sum + (r.solar_radiation as number), count: existing.count + 1 });
    }
    return Array.from(buckets.entries())
      .map(([ts, d]) => ({ x: new Date(ts).toISOString(), y: d.sum / d.count }))
      .sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());
  }, [weatherHistory]);

  // Hourly max UV index
  const hourlyUV = useMemo(() => {
    const buckets = new Map<number, number>();
    for (const r of weatherHistory) {
      if (r.uv_index == null) continue;
      const ts = new Date(r.ts).getTime();
      const bucketTs = Math.floor(ts / 3600000) * 3600000;
      const existing = buckets.get(bucketTs) ?? 0;
      buckets.set(bucketTs, Math.max(existing, r.uv_index as number));
    }
    return Array.from(buckets.entries())
      .map(([ts, val]) => ({ x: new Date(ts).toISOString(), y: val }))
      .sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());
  }, [weatherHistory]);

  const hasUV = hourlyUV.some((d) => d.y > 0);

  const chartData = useMemo(() => ({
    datasets: [
      {
        type: "line" as const,
        data: hourlySolar,
        borderColor: "#ffc107",
        backgroundColor: "rgba(255, 193, 7, 0.15)",
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
        yAxisID: "y",
      },
      ...(hasUV ? [{
        type: "line" as const,
        data: hourlyUV,
        borderColor: "#ff9800",
        backgroundColor: "transparent",
        fill: false,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
        yAxisID: "y2",
        borderDash: [4, 2],
      }] : []),
    ],
  }), [hourlySolar, hourlyUV, hasUV]);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
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
      y2: {
        display: hasUV,
        position: "right" as const,
        min: 0,
        suggestedMax: 11,
        grid: { drawOnChartArea: false },
        ticks: { color: "#ff9800", font: { size: 10 }, stepSize: 2 },
      },
    },
    elements: {
      point: { radius: 0, hitRadius: 10, hoverRadius: 4 },
    },
    interaction: {
      intersect: false,
      mode: "index" as const,
    },
  }), [hasUV]);

  return (
    <MetricCard flash={flash} className="p-4 pb-0 flex flex-col">
      <div className="flex flex-col z-10 w-full mb-[100px]">
        <h3 className="text-[0.95rem] font-medium text-text mb-2">Solar</h3>

        <div className="flex items-start gap-6 mb-2">
          <div className="flex flex-col">
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-semibold leading-none text-yellow tracking-tight">
                {fmt(radiation, 0)}
              </span>
              <span className="text-sm text-dim">W/m²</span>
            </div>
            <span className="text-[0.75rem] text-text font-medium mt-1">Radiation</span>
          </div>

          <div className="flex flex-col">
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-semibold leading-none tracking-tight" style={{ color: uvColor }}>
                {uvIndex != null ? uvIndex : "--"}
              </span>
              <span className="text-sm font-medium" style={{ color: uvColor }}>
                {uvStatus.label}
              </span>
            </div>
            <span className="text-[0.75rem] text-text font-medium mt-1">UV Index</span>
          </div>

          {sky && (
            <div className="flex flex-col items-center ml-auto self-center">
              <sky.Icon className="w-7 h-7" style={{ color: sky.color }} strokeWidth={1.8} />
              <span className="text-[0.65rem] text-dim mt-0.5">{sky.label}</span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
          <span>Peak <span className="text-text font-medium">{peakRadiation} W/m²</span></span>
          <span>Peak UV <span className="font-medium" style={{ color: peakUvColor }}>{peakUv}</span></span>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-[100px] w-full px-2 pb-1 z-0 rounded-b-xl overflow-hidden">
        {hourlySolar.length > 0 && <Chart type="line" data={chartData} options={chartOptions} />}
      </div>
    </MetricCard>
  );
}
