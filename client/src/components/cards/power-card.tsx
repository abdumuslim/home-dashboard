import { useState, useEffect, useMemo } from "react";
import { Line, Bar } from "react-chartjs-2";
import { Zap, Maximize2 } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";
import { useFlash } from "@/hooks/use-flash";
import { useChartsVisible } from "@/hooks/use-charts-visible";
import { fmt } from "@/constants/thresholds";
import { getBucketMs, bucketAverage, expandedChartOptions } from "@/constants/chart-utils";
import type { PowerReading, OpenOverlayFn, TimeRange } from "@/types/api";

const GRID_COLOR = "#818cf8";
const GEN_COLOR = "#fb7185";
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
  const p1Data = useMemo(() => bucketAverage(history, "power_1", bMs), [history, bMs]);
  const p2Data = useMemo(() => bucketAverage(history, "power_2", bMs), [history, bMs]);
  const vData = useMemo(() => bucketAverage(history, "voltage", bMs), [history, bMs]);

  const data = {
    datasets: [
      {
        label: "Grid (W)",
        data: p1Data,
        borderColor: GRID_COLOR,
        backgroundColor: `${GRID_COLOR}18`,
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
        yAxisID: "y",
      },
      {
        label: "Generator (W)",
        data: p2Data,
        borderColor: GEN_COLOR,
        backgroundColor: `${GEN_COLOR}18`,
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
        yAxisID: "y",
      },
      {
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
      },
    ],
  };

  const base = expandedChartOptions(range, "W");
  const options = {
    ...base,
    plugins: {
      ...base.plugins,
      legend: { display: true, labels: { color: "#7a8ba8", boxWidth: 12, padding: 16 } },
    },
    scales: {
      ...base.scales,
      y2: {
        position: "right" as const,
        title: { display: true, text: "V", color: "#94a3b8", font: { size: 11 } },
        grid: { drawOnChartArea: false },
        ticks: { color: "#94a3b8", font: { size: 11 } },
      },
    },
  };

  return <div className="h-full"><Line data={data} options={options} /></div>;
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
  const heroColor = activeSource === "grid" ? GRID_COLOR : activeSource === "gen" ? GEN_COLOR : "#7a8ba8";

  const flash = useFlash(heroPower != null ? fmt(heroPower, 0) : null);

  const hourlyData1 = useMemo(() => {
    const buckets = new Map<number, { sum: number; count: number }>();
    for (const r of powerHistory) {
      if (r.current_1 == null) continue;
      const ts = new Date(r.ts).getTime();
      const key = Math.floor(ts / 3600000) * 3600000;
      const b = buckets.get(key) || { sum: 0, count: 0 };
      b.sum += r.current_1;
      b.count += 1;
      buckets.set(key, b);
    }
    return Array.from(buckets.entries())
      .map(([ts, d]) => ({ x: new Date(ts).toISOString(), y: d.sum / d.count }))
      .sort((a, b) => a.x.localeCompare(b.x));
  }, [powerHistory]);

  const hourlyData2 = useMemo(() => {
    const buckets = new Map<number, { sum: number; count: number }>();
    for (const r of powerHistory) {
      if (r.current_2 == null) continue;
      const ts = new Date(r.ts).getTime();
      const key = Math.floor(ts / 3600000) * 3600000;
      const b = buckets.get(key) || { sum: 0, count: 0 };
      b.sum += r.current_2;
      b.count += 1;
      buckets.set(key, b);
    }
    return Array.from(buckets.entries())
      .map(([ts, d]) => ({ x: new Date(ts).toISOString(), y: d.sum / d.count }))
      .sort((a, b) => a.x.localeCompare(b.x));
  }, [powerHistory]);

  const chartData = {
    datasets: [
      {
        data: hourlyData1,
        backgroundColor: `${GRID_COLOR}90`,
        borderColor: GRID_COLOR,
        borderWidth: 1,
        borderRadius: 2,
      },
      {
        data: hourlyData2,
        backgroundColor: `${GEN_COLOR}90`,
        borderColor: GEN_COLOR,
        borderWidth: 1,
        borderRadius: 2,
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
        stacked: true,
        time: { unit: "hour" as const, stepSize: 1, displayFormats: { hour: "h" } },
        grid: { display: false },
        ticks: { color: "#7a8ba8", font: { size: 9 }, maxRotation: 0, autoSkip: false, autoSkipPadding: 0, padding: 0 },
      },
      y: {
        display: true,
        stacked: true,
        position: "left" as const,
        grid: { color: "rgba(255,255,255,0.05)" },
        ticks: { color: "#7a8ba8", font: { size: 10 }, maxTicksLimit: 5 },
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
        <div className="flex items-baseline gap-5 mt-1">
          <div className="flex flex-col">
            <span
              className="text-2xl md:text-3xl font-semibold leading-none tracking-tight"
              style={{ color: heroColor }}
            >
              {heroPower != null ? fmt(heroPower, 0) : "--"}
              <span className="text-sm text-dim ml-1">W</span>
            </span>
            <span className="text-[0.75rem] text-text font-medium mt-1">
              {activeSource === "grid" ? "Grid" : activeSource === "gen" ? "Generator" : "Power"}
            </span>
          </div>

          <div className="flex flex-col">
            <span className="text-2xl md:text-3xl font-semibold leading-none tracking-tight text-white">
              {fmt(power?.voltage, 0)}
              <span className="text-sm text-dim ml-1">V</span>
            </span>
            <span className="text-[0.75rem] text-text font-medium mt-1">Voltage</span>
          </div>
        </div>

        {/* Secondary row: source pills + current values */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim mt-2">
          <SourcePill label="Grid" active={gridActive} color={GRID_COLOR} />
          <span className="text-text font-medium">{fmt(power?.current_1, 1)}A</span>
          <SourcePill label="Gen" active={genActive} color={GEN_COLOR} />
          <span className="text-text font-medium">{fmt(power?.current_2, 1)}A</span>
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
        {(hourlyData1.length > 0 || hourlyData2.length > 0) && (
          <Bar data={chartData} options={chartOptions} />
        )}
      </div>
    </MetricCard>
  );
}
