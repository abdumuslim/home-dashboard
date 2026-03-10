import { useState, useEffect, useMemo } from "react";
import { Bar } from "react-chartjs-2";
import { Zap, Maximize2 } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";
import { useFlash } from "@/hooks/use-flash";
import { useChartsVisible } from "@/hooks/use-charts-visible";
import { fmt } from "@/constants/thresholds";
import { getBucketMs, bucketAverage, expandedChartOptions } from "@/constants/chart-utils";
import type { PowerReading, OpenOverlayFn, TimeRange } from "@/types/api";

const GRID_COLOR = "#38bdf8";
const GEN_COLOR = "#fb923c";
const NOISE_THRESHOLD = 0.1;

interface PowerCardProps {
  power: PowerReading | null;
  powerHistory: PowerReading[];
  openOverlay: OpenOverlayFn;
}

function SourcePill({ label, active, color }: { label: string; active: boolean; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[0.65rem] font-semibold uppercase tracking-wide transition-all"
      style={active ? {
        backgroundColor: `${color}20`,
        color: color,
      } : {
        backgroundColor: "rgba(255,255,255,0.03)",
        color: "#7a8ba8",
      }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={active ? {
          backgroundColor: color,
          boxShadow: `0 0 6px ${color}, 0 0 12px ${color}50`,
        } : {
          backgroundColor: "#4a5568",
        }}
      />
      {label}
    </span>
  );
}

function ExpandedPowerChart({ range }: { range: TimeRange }) {
  const [history, setHistory] = useState<PowerReading[]>([]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/history?source=power&range=${range}`);
        const json = await res.json();
        if (mounted) setHistory(json.data || []);
      } catch (e) {
        console.error("Failed to fetch power history:", e);
      }
    };
    load();
    return () => { mounted = false; };
  }, [range]);

  const bMs = getBucketMs(range);

  // Single bar dataset colored per-source, based on current
  const { barData, barColors } = useMemo(() => {
    const buckets = new Map<number, { sum1: number; cnt1: number; sum2: number; cnt2: number }>();
    for (const r of history) {
      const ts = new Date(r.ts).getTime();
      const key = Math.floor(ts / bMs) * bMs;
      const b = buckets.get(key) || { sum1: 0, cnt1: 0, sum2: 0, cnt2: 0 };
      if (r.current_1 != null) { b.sum1 += r.current_1; b.cnt1 += 1; }
      if (r.current_2 != null) { b.sum2 += r.current_2; b.cnt2 += 1; }
      buckets.set(key, b);
    }
    const sorted = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
    const data: { x: string; y: number }[] = [];
    const colors: string[] = [];
    for (const [ts, b] of sorted) {
      const avg1 = b.cnt1 > 0 ? b.sum1 / b.cnt1 : 0;
      const avg2 = b.cnt2 > 0 ? b.sum2 / b.cnt2 : 0;
      const isGrid = avg1 >= avg2;
      data.push({ x: new Date(ts).toISOString(), y: isGrid ? avg1 : avg2 });
      colors.push(isGrid ? GRID_COLOR : GEN_COLOR);
    }
    return { barData: data, barColors: colors };
  }, [history, bMs]);

  const vData = useMemo(() => bucketAverage(history, "voltage", bMs), [history, bMs]);

  const barThickness = range === "6h" ? 6 : range === "24h" ? 4 : 3;

  const data = {
    datasets: [
      {
        type: "bar" as const,
        label: "Current (A)",
        data: barData,
        backgroundColor: barColors,
        borderRadius: 2,
        barThickness,
        yAxisID: "y",
        order: 2,
      },
      {
        type: "line" as const,
        label: "Voltage (V)",
        data: vData,
        borderColor: "#94a3b8",
        backgroundColor: "transparent",
        fill: false,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
        borderDash: [4, 2],
        yAxisID: "y2",
        order: 1,
      },
    ],
  };

  const base = expandedChartOptions(range, "A");
  const options = {
    ...base,
    plugins: {
      ...base.plugins,
      legend: { display: true, labels: { color: "#7a8ba8", boxWidth: 12, padding: 16 } },
    },
    scales: {
      ...base.scales,
      x: {
        ...base.scales.x,
        offset: true,
      },
      y: {
        ...base.scales.y,
        beginAtZero: true,
      },
      y2: {
        position: "right" as const,
        title: { display: true, text: "V", color: "#94a3b8", font: { size: 11 } },
        grid: { drawOnChartArea: false },
        ticks: { color: "#94a3b8", font: { size: 11 } },
      },
    },
  };

  // Chart.js mixed charts use the Chart component via Bar with type overrides
  return <div className="h-full"><Bar data={data as any} options={options} /></div>;
}

export function PowerCard({ power, powerHistory, openOverlay }: PowerCardProps) {
  const { chartsVisible } = useChartsVisible();

  const gridActive = (power?.current_1 ?? 0) > NOISE_THRESHOLD;
  const genActive = (power?.current_2 ?? 0) > NOISE_THRESHOLD;

  // Determine which source to show as hero power value
  const activeSource = gridActive && genActive
    ? ((power?.current_1 ?? 0) >= (power?.current_2 ?? 0) ? "grid" : "gen")
    : gridActive ? "grid" : genActive ? "gen" : null;

  const heroPower = activeSource === "grid" ? power?.power_1 : activeSource === "gen" ? power?.power_2 : null;
  const heroCurrent = activeSource === "grid" ? power?.current_1 : activeSource === "gen" ? power?.current_2 : null;
  const heroColor = activeSource === "grid" ? GRID_COLOR : activeSource === "gen" ? GEN_COLOR : "#7a8ba8";

  // Only flash on source change, not on every wattage fluctuation
  const flash = useFlash(activeSource);

  // 30-min buckets, single bar colored by dominant source
  const BUCKET_MS = 30 * 60_000;
  const { barData, barColors } = useMemo(() => {
    const buckets = new Map<number, { sum1: number; cnt1: number; sum2: number; cnt2: number }>();
    for (const r of powerHistory) {
      const ts = new Date(r.ts).getTime();
      const key = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
      const b = buckets.get(key) || { sum1: 0, cnt1: 0, sum2: 0, cnt2: 0 };
      if (r.current_1 != null) { b.sum1 += r.current_1; b.cnt1 += 1; }
      if (r.current_2 != null) { b.sum2 += r.current_2; b.cnt2 += 1; }
      buckets.set(key, b);
    }
    const sorted = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
    const data: { x: string; y: number }[] = [];
    const colors: string[] = [];
    for (const [ts, b] of sorted) {
      const avg1 = b.cnt1 > 0 ? b.sum1 / b.cnt1 : 0;
      const avg2 = b.cnt2 > 0 ? b.sum2 / b.cnt2 : 0;
      const isGrid = avg1 >= avg2;
      data.push({ x: new Date(ts).toISOString(), y: isGrid ? avg1 : avg2 });
      colors.push(isGrid ? GRID_COLOR : GEN_COLOR);
    }
    return { barData: data, barColors: colors };
  }, [powerHistory]);

  const chartData = {
    datasets: [
      {
        data: barData,
        backgroundColor: barColors,
        borderRadius: 1,
        barThickness: 2,
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
        offset: true,
        time: { unit: "hour" as const, stepSize: 1, displayFormats: { hour: "h" } },
        grid: { display: false },
        ticks: { color: "#7a8ba8", font: { size: 9 }, maxRotation: 0, autoSkip: false, autoSkipPadding: 0, padding: 0 },
      },
      y: {
        display: true,
        position: "left" as const,
        beginAtZero: true,
        grid: { color: "rgba(255,255,255,0.05)" },
        ticks: { color: "#7a8ba8", font: { size: 10 }, maxTicksLimit: 4 },
      },
    },
    interaction: { intersect: false, mode: "index" as const },
  };

  const handleExpand = () => {
    openOverlay("Power", (_range) => (
      <ExpandedPowerChart range={_range} />
    ));
  };

  return (
    <MetricCard flash={flash} className="p-4 pb-0 flex flex-col">
      <div className={`flex flex-col z-10 w-full transition-[margin] duration-300 ${chartsVisible ? "mb-[100px]" : "mb-3"}`}>
        {/* Title */}
        <h3 className="text-[0.95rem] font-medium text-text mb-2 mt-1 flex items-center gap-1.5">
          <Zap className="w-4 h-4" style={{ color: heroColor }} />
          Power
        </h3>

        {/* Hero row */}
        <div className="flex items-baseline gap-4 mt-1">
          <div className="flex flex-col">
            <span
              className="text-2xl md:text-3xl font-semibold leading-none tracking-tight"
              style={{ color: heroColor }}
            >
              {heroPower != null ? (heroPower / 1000).toFixed(2) : "--"}
              <span className="text-sm text-dim ml-1">kW</span>
            </span>
            <span className="text-[0.75rem] text-text font-medium mt-1">Power</span>
          </div>

          <div className="flex flex-col">
            <span
              className="text-2xl md:text-3xl font-semibold leading-none tracking-tight"
              style={{ color: heroColor }}
            >
              {fmt(power?.voltage, 0)}
              <span className="text-sm text-dim ml-1">V</span>
            </span>
            <span className="text-[0.75rem] text-text font-medium mt-1">Voltage</span>
          </div>

          <div className="flex flex-col">
            <span
              className="text-2xl md:text-3xl font-semibold leading-none tracking-tight"
              style={{ color: heroColor }}
            >
              {heroCurrent != null ? fmt(heroCurrent, 1) : "--"}
              <span className="text-sm text-dim ml-1">A</span>
            </span>
            <span className="text-[0.75rem] text-text font-medium mt-1">Current</span>
          </div>
        </div>

        {/* Source indicators */}
        <div className="flex items-center gap-x-3 text-xs mt-2">
          <SourcePill label="Grid" active={gridActive} color={GRID_COLOR} />
          <SourcePill label="Gen" active={genActive} color={GEN_COLOR} />
        </div>
      </div>

      {/* Inline chart */}
      <div
        className={`absolute bottom-0 left-0 right-0 h-[100px] w-full px-2 pb-1 z-0 rounded-b-xl overflow-hidden group cursor-pointer transition-opacity duration-300 ${chartsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={handleExpand}
      >
        <div className="absolute top-1 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
          <Maximize2 className="w-3.5 h-3.5 text-dim" />
        </div>
        {barData.length > 0 && (
          <Bar data={chartData} options={chartOptions} />
        )}
      </div>
    </MetricCard>
  );
}
