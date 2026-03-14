import { useMemo, useState, useEffect, memo } from "react";
import { Chart } from "react-chartjs-2";
import { Sun, CloudSun, Cloud, Maximize2 } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";
import { useFlash } from "@/hooks/use-flash";
import { useUnits } from "@/hooks/use-units";
import { useChartsVisible } from "@/hooks/use-charts-visible";
import { fmt, getStatus } from "@/constants/thresholds";
import { convertSolar } from "@/constants/units";
import { getBucketMs, bucketAverage, bucketMax, expandedChartOptions } from "@/constants/chart-utils";
import type { WeatherReading, OpenOverlayFn, TimeRange } from "@/types/api";

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
  openOverlay: OpenOverlayFn;
}

interface SkyResult { label: string; Icon: typeof Sun; color: string }

function getSkyCondition(
  radiation: number | null | undefined,
  ref: number | null,
  history: WeatherReading[],
): SkyResult | null {
  if (ref == null || ref < 1 || radiation == null) return null;
  const level = radiation / ref;
  const now = Date.now();
  const pts = history
    .filter((r) => r.solar_radiation != null && now - new Date(r.ts).getTime() <= 600000)
    .map((r) => ({ t: new Date(r.ts).getTime(), v: r.solar_radiation as number }))
    .sort((a, b) => a.t - b.t);

  let variability = 0;
  if (pts.length >= 3) {
    const first = pts[0], last = pts[pts.length - 1];
    const dt = last.t - first.t;
    const slope = dt > 0 ? (last.v - first.v) / dt : 0;
    let maxDev = 0;
    for (const pt of pts) {
      const expected = first.v + slope * (pt.t - first.t);
      maxDev = Math.max(maxDev, Math.abs(pt.v - expected));
    }
    variability = ref > 0 ? maxDev / ref : 0;
  }

  if (level > 0.7) {
    if (variability < 0.15) return { label: "Sunny", Icon: Sun, color: "#ffc107" };
    return { label: "Partly Cloudy", Icon: CloudSun, color: "#fbbf24" };
  }
  if (level > 0.4) {
    if (variability < 0.15) return { label: "Partly Cloudy", Icon: CloudSun, color: "#fbbf24" };
    return { label: "Mostly Cloudy", Icon: Cloud, color: "#94a3b8" };
  }
  if (level > 0.15) return { label: "Mostly Cloudy", Icon: Cloud, color: "#94a3b8" };
  return { label: "Overcast", Icon: Cloud, color: "#64748b" };
}

function ExpandedSolarChart({ range, weatherHistory }: { range: TimeRange; weatherHistory: WeatherReading[] }) {
  const { solarLabel, units: { solar: solarUnit } } = useUnits();
  const bMs = getBucketMs(range);
  const solarData = useMemo(
    () => bucketAverage(weatherHistory, "solar_radiation", bMs).map(p => ({ ...p, y: convertSolar(p.y, solarUnit) })),
    [weatherHistory, bMs, solarUnit],
  );
  const uvData = useMemo(() => bucketMax(weatherHistory, "uv_index", bMs), [weatherHistory, bMs]);
  const hasUV = uvData.some((d) => d.y > 0);

  const data = {
    datasets: [
      {
        type: "line" as const,
        label: `Solar Radiation (${solarLabel})`,
        data: solarData,
        borderColor: "#ffc107",
        backgroundColor: "rgba(255, 193, 7, 0.1)",
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
        yAxisID: "y",
      },
      ...(hasUV ? [{
        type: "line" as const,
        label: "UV Index (max)",
        data: uvData,
        borderColor: "#ff9800",
        backgroundColor: "transparent",
        fill: false,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
        borderDash: [4, 2],
        yAxisID: "y2",
      }] : []),
    ],
  };

  const base = expandedChartOptions(range, solarLabel);
  const options = {
    ...base,
    plugins: {
      ...base.plugins,
      legend: { display: true, labels: { color: "#7a8ba8", boxWidth: 12, padding: 16 } },
    },
    scales: {
      ...base.scales,
      y: { ...base.scales.y, ticks: { ...base.scales.y.ticks, stepSize: 200 } },
      y2: {
        display: hasUV,
        position: "right" as const,
        title: { display: true, text: "UV Index", color: "#ff9800", font: { size: 11 } },
        min: 0,
        suggestedMax: Math.max(...uvData.map((d) => d.y), 3) + 1,
        grid: { drawOnChartArea: false },
        ticks: { color: "#ff9800", font: { size: 11 }, stepSize: 1 },
      },
    },
  };

  return <div className="h-full"><Chart type="line" data={data} options={options} /></div>;
}

export const SolarCard = memo(function SolarCard({ radiation, uvIndex, weatherHistory = [], openOverlay }: SolarCardProps) {
  const { fmtSolar, solarLabel, units: { solar: solarUnit } } = useUnits();
  const { chartsVisible } = useChartsVisible();
  const flashRad = useFlash(radiation != null ? fmtSolar(radiation) : null);
  const flashUV = useFlash(uvIndex != null ? fmt(uvIndex, 0) : null);
  const flash = flashRad || flashUV;
  const uvStatus = getStatus("uv", uvIndex);
  const uvColor = uvStatus.level ? UV_COLORS[uvStatus.level] : "#7a8ba8";

  const [quarterMax, setQuarterMax] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    let mounted = true;
    const fetchRef = async () => {
      try {
        const res = await fetch("/api/solar-reference");
        const data = await res.json();
        if (mounted) setQuarterMax(data.quarter_hourly_max);
      } catch { /* ignore */ }
    };
    fetchRef();
    const id = setInterval(fetchRef, 300000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  const now = new Date();
  const h = now.getHours();
  const slot5 = Math.floor(now.getMinutes() / 5);
  const getRef = (qm: Record<string, number>): number | null => {
    const key = `${h}:${slot5}`;
    if (key in qm) return qm[key];
    for (const adj of [slot5 - 1, slot5 + 1]) {
      const adjH = adj < 0 ? h - 1 : adj > 11 ? h + 1 : h;
      const adjS = ((adj % 12) + 12) % 12;
      const adjKey = `${adjH}:${adjS}`;
      if (adjKey in qm) return qm[adjKey];
    }
    return null;
  };
  const sky = getSkyCondition(radiation, quarterMax ? getRef(quarterMax) : null, weatherHistory);

  const { peakRad, peakUv, peakUvColor } = useMemo(() => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const today = weatherHistory.filter((r) => new Date(r.ts) >= midnight);
    const rads = today.filter((r) => r.solar_radiation != null).map((r) => r.solar_radiation as number);
    const uvs = today.filter((r) => r.uv_index != null).map((r) => r.uv_index as number);
    const peakRadVal = rads.length > 0 ? Math.max(...rads) : null;
    const peakUvVal = uvs.length > 0 ? Math.max(...uvs) : null;
    const peakUvStatus = getStatus("uv", peakUvVal);
    return {
      peakRad: peakRadVal,
      peakUv: peakUvVal != null ? fmt(peakUvVal, 0) : "--",
      peakUvColor: peakUvStatus.level ? UV_COLORS[peakUvStatus.level] : "#7a8ba8",
    };
  }, [weatherHistory]);

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
      .map(([ts, d]) => ({ x: new Date(ts).toISOString(), y: convertSolar(d.sum / d.count, solarUnit) }))
      .sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());
  }, [weatherHistory, solarUnit]);

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
        ticks: { color: "#7a8ba8", font: { size: 10 }, stepSize: 200 },
      },
      y2: {
        display: hasUV,
        position: "right" as const,
        min: 0,
        suggestedMax: Math.max(...hourlyUV.map((d) => d.y), 3) + 1,
        grid: { drawOnChartArea: false },
        ticks: { color: "#ff9800", font: { size: 10 }, stepSize: 1 },
      },
    },
    elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 4 } },
    interaction: { intersect: false, mode: "index" as const },
  }), [hasUV, hourlyUV]);

  const handleExpand = () => {
    openOverlay("Solar & UV", (range, wh) => (
      <ExpandedSolarChart range={range} weatherHistory={wh} />
    ));
  };

  return (
    <MetricCard flash={flash} className="p-4 pb-0 flex flex-col">
      <div className={`flex flex-col z-10 w-full transition-[margin] duration-300 ${chartsVisible ? "mb-[100px]" : "mb-3"}`}>
        <h3 className="text-[0.95rem] font-medium text-text mb-2">Solar</h3>

        <div className="flex items-start gap-3 md:gap-6 mb-2">
          <div className="flex flex-col">
            <div className="flex items-baseline gap-1">
              <span className="text-2xl md:text-3xl font-semibold leading-none text-yellow tracking-tight">
                {fmtSolar(radiation)}
              </span>
              <span className="text-sm text-dim">{solarLabel}</span>
            </div>
            <span className="text-[0.75rem] text-text font-medium mt-1">Radiation</span>
          </div>

          <div className="flex flex-col">
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl md:text-3xl font-semibold leading-none tracking-tight" style={{ color: uvColor }}>
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
          <span>Peak <span className="text-text font-medium">{fmtSolar(peakRad)} {solarLabel}</span></span>
          <span>Peak UV <span className="font-medium" style={{ color: peakUvColor }}>{peakUv}</span></span>
        </div>
      </div>

      <div
        className={`absolute bottom-0 left-0 right-0 h-[100px] w-full px-2 pb-1 z-0 rounded-b-xl overflow-hidden group cursor-pointer transition-opacity duration-300 ${chartsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={handleExpand}
      >
        <div className="absolute top-1 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
          <Maximize2 className="w-3.5 h-3.5 text-dim" />
        </div>
        {hourlySolar.length > 0 && <Chart type="line" data={chartData} options={chartOptions} />}
      </div>
    </MetricCard>
  );
});
