import { useMemo } from "react";
import { Line } from "react-chartjs-2";
import { Maximize2 } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";
import { useFlash } from "@/hooks/use-flash";
import { useUnits } from "@/hooks/use-units";
import { fmt, getTempColor } from "@/constants/thresholds";
import { convertTemp, convertTempDelta } from "@/constants/units";
import { getBucketMs, bucketAverage, expandedChartOptions } from "@/constants/chart-utils";
import type { WeatherReading, OpenOverlayFn, TimeRange } from "@/types/api";

interface TemperatureCardProps {
  temp: number | null | undefined;
  humidity: number | null | undefined;
  dewPoint: number | null | undefined;
  feelsLike: number | null | undefined;
  weatherHistory?: WeatherReading[];
  openOverlay: OpenOverlayFn;
}

function ExpandedTemperatureChart({ range, weatherHistory }: { range: TimeRange; weatherHistory: WeatherReading[] }) {
  const { tempLabel, units: { temperature: tempUnit } } = useUnits();
  const bMs = getBucketMs(range);
  const tempData = useMemo(
    () => bucketAverage(weatherHistory, "temp_c", bMs).map(p => ({ ...p, y: convertTemp(p.y, tempUnit) })),
    [weatherHistory, bMs, tempUnit],
  );
  const humData = useMemo(() => bucketAverage(weatherHistory, "humidity", bMs), [weatherHistory, bMs]);

  const data = {
    datasets: [
      {
        label: `Temperature (${tempLabel})`,
        data: tempData,
        borderColor: "#00d4ff",
        backgroundColor: "rgba(0, 212, 255, 0.1)",
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        cubicInterpolationMode: "monotone" as const,
        yAxisID: "y",
      },
      {
        label: "Humidity (%)",
        data: humData,
        borderColor: "#8b5cf6",
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

  const base = expandedChartOptions(range, tempLabel);
  const options = {
    ...base,
    plugins: {
      ...base.plugins,
      legend: { display: true, labels: { color: "#7a8ba8", boxWidth: 12, padding: 16 } },
    },
    scales: {
      ...base.scales,
      y: { ...base.scales.y, ticks: { ...base.scales.y.ticks, stepSize: 2 } },
      y2: {
        position: "right" as const,
        title: { display: true, text: "%", color: "#7a8ba8", font: { size: 11 } },
        grid: { drawOnChartArea: false },
        ticks: { color: "#8b5cf6", font: { size: 11 } },
        min: 0,
        max: 100,
      },
    },
  };

  return <div className="h-full"><Line data={data} options={options} /></div>;
}

export function TemperatureCard({ temp, humidity, dewPoint, feelsLike, weatherHistory = [], openOverlay }: TemperatureCardProps) {
  const { fmtTemp, tempLabel, units: { temperature: tempUnit } } = useUnits();
  const flash = useFlash(temp != null ? fmtTemp(temp) : null);

  const { hiTemp, loTemp } = useMemo(() => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const today = weatherHistory.filter(
      (r) => r.temp_c != null && new Date(r.ts) >= midnight
    );
    if (today.length === 0) return { hiTemp: null, loTemp: null };
    const temps = today.map((r) => r.temp_c as number);
    return { hiTemp: Math.max(...temps), loTemp: Math.min(...temps) };
  }, [weatherHistory]);

  const { tempDelta, humDelta } = useMemo(() => {
    if (temp == null || humidity == null || weatherHistory.length === 0)
      return { tempDelta: null, humDelta: null };
    const target = Date.now() - 86400000;
    let closest = weatherHistory[0];
    let minDiff = Math.abs(new Date(closest.ts).getTime() - target);
    for (const r of weatherHistory) {
      const diff = Math.abs(new Date(r.ts).getTime() - target);
      if (diff < minDiff) { closest = r; minDiff = diff; }
    }
    if (minDiff > 3600000 || closest.temp_c == null || closest.humidity == null)
      return { tempDelta: null, humDelta: null };
    return {
      tempDelta: temp - closest.temp_c,
      humDelta: humidity - closest.humidity,
    };
  }, [weatherHistory, temp, humidity]);

  const hourlyData = useMemo(() => {
    const buckets = new Map<number, { sum: number; count: number }>();
    for (const r of weatherHistory) {
      if (r.temp_c == null) continue;
      const ts = new Date(r.ts).getTime();
      const bucketTs = Math.floor(ts / 3600000) * 3600000;
      const existing = buckets.get(bucketTs) || { sum: 0, count: 0 };
      buckets.set(bucketTs, { sum: existing.sum + (r.temp_c as number), count: existing.count + 1 });
    }
    return Array.from(buckets.entries())
      .map(([ts, d]) => ({ x: new Date(ts).toISOString(), y: convertTemp(d.sum / d.count, tempUnit) }))
      .sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());
  }, [weatherHistory, tempUnit]);

  const chartData = {
    datasets: [
      {
        data: hourlyData,
        borderColor: "#00d4ff",
        backgroundColor: "rgba(0, 212, 255, 0.15)",
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
        ticks: { color: "#7a8ba8", font: { size: 10 }, stepSize: 2 },
      },
    },
    elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 4 } },
    interaction: { intersect: false, mode: "index" as const },
  };

  const handleExpand = () => {
    openOverlay("Temp & Humidity", (range, wh) => (
      <ExpandedTemperatureChart range={range} weatherHistory={wh} />
    ));
  };

  return (
    <MetricCard flash={flash} className="p-4 pb-0 flex flex-col">
      <div className="flex flex-col z-10 w-full mb-[100px]">
        <h3 className="text-[0.95rem] font-medium text-text mb-2">Temp &amp; Humidity</h3>

        <div className="flex items-baseline gap-8 mb-2">
          <div className="flex flex-col">
            <span className="text-3xl font-semibold leading-none tracking-tight" style={{ color: getTempColor(temp) }}>
              {fmtTemp(temp)}<span className="text-xl">{tempLabel}</span>
              {tempDelta != null && tempDelta !== 0 && (
                <span className={`text-xs ml-1.5 font-medium ${tempDelta > 0 ? "text-red-400" : "text-blue-400"}`}>
                  {tempDelta > 0 ? "\u2191" : "\u2193"}{fmt(Math.abs(convertTempDelta(tempDelta, tempUnit)), 1)}&deg;
                </span>
              )}
            </span>
            <span className="text-[0.75rem] text-text font-medium mt-1">Temp.</span>
          </div>

          <div className="flex flex-col">
            <span className="text-3xl font-semibold leading-none text-cyan tracking-tight">
              {fmt(humidity, 0)}<span className="text-xl">%</span>
              {humDelta != null && humDelta !== 0 && (
                <span className={`text-xs ml-1.5 font-medium ${humDelta > 0 ? "text-red-400" : "text-blue-400"}`}>
                  {humDelta > 0 ? "\u2191" : "\u2193"}{fmt(Math.abs(humDelta), 0)}%
                </span>
              )}
            </span>
            <span className="text-[0.75rem] text-text font-medium mt-1">Humidity</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
          {hiTemp != null && loTemp != null && (
            <span>
              <span className="text-red-400">&uarr;</span>
              <span className="text-text font-medium">{fmtTemp(hiTemp)}&deg;</span>
              {" "}
              <span className="text-blue-400">&darr;</span>
              <span className="text-text font-medium">{fmtTemp(loTemp)}&deg;</span>
            </span>
          )}
          <span>Dew Point <span className="text-text font-medium">{fmtTemp(dewPoint)}{tempLabel}</span></span>
          <span>Feels Like <span className="text-text font-medium">{fmtTemp(feelsLike)}{tempLabel}</span></span>
        </div>
      </div>

      <div
        className="absolute bottom-0 left-0 right-0 h-[100px] w-full px-2 pb-1 z-0 rounded-b-xl overflow-hidden group cursor-pointer"
        onClick={handleExpand}
      >
        <div className="absolute top-1 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
          <Maximize2 className="w-3.5 h-3.5 text-dim" />
        </div>
        {hourlyData.length > 0 && <Line data={chartData} options={chartOptions} />}
      </div>
    </MetricCard>
  );
}
