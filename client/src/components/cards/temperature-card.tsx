import { useMemo } from "react";
import { Line } from "react-chartjs-2";
import { MetricCard } from "@/components/ui/metric-card";
import { useFlash } from "@/hooks/use-flash";
import { fmt, getTempColor } from "@/constants/thresholds";
import type { WeatherReading } from "@/types/api";

interface TemperatureCardProps {
  temp: number | null | undefined;
  humidity: number | null | undefined;
  dewPoint: number | null | undefined;
  feelsLike: number | null | undefined;
  weatherHistory?: WeatherReading[];
}

export function TemperatureCard({ temp, humidity, dewPoint, feelsLike, weatherHistory = [] }: TemperatureCardProps) {
  const flash = useFlash(temp != null ? fmt(temp, 1) : null);

  // Today's hi/lo since midnight
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

  // Downsample to hourly averages for smooth chart (same approach as indoor cards)
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
      .map(([ts, d]) => ({ x: new Date(ts).toISOString(), y: d.sum / d.count }))
      .sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());
  }, [weatherHistory]);

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
        ticks: { color: "#7a8ba8", font: { size: 10 }, stepSize: 2 },
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
        <h3 className="text-[0.95rem] font-medium text-text mb-2">Temp &amp; Humidity</h3>

        <div className="flex items-baseline gap-8 mb-2">
          <div className="flex flex-col">
            <span className="text-3xl font-semibold leading-none tracking-tight" style={{ color: getTempColor(temp) }}>
              {fmt(temp, 1)}<span className="text-xl">&deg;C</span>
            </span>
            <span className="text-[0.75rem] text-text font-medium mt-1">Temp.</span>
          </div>

          <div className="flex flex-col">
            <span className="text-3xl font-semibold leading-none text-cyan tracking-tight">
              {fmt(humidity, 0)}<span className="text-xl">%</span>
            </span>
            <span className="text-[0.75rem] text-text font-medium mt-1">Humidity</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
          {hiTemp != null && loTemp != null && (
            <span>
              <span className="text-red-400">&uarr;</span>
              <span className="text-text font-medium">{fmt(hiTemp, 1)}&deg;</span>
              {" "}
              <span className="text-blue-400">&darr;</span>
              <span className="text-text font-medium">{fmt(loTemp, 1)}&deg;</span>
            </span>
          )}
          <span>Dew Point <span className="text-text font-medium">{fmt(dewPoint, 1)}&deg;C</span></span>
          <span>Feels Like <span className="text-text font-medium">{fmt(feelsLike, 1)}&deg;C</span></span>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-[100px] w-full px-2 pb-1 z-0 rounded-b-xl overflow-hidden">
        {hourlyData.length > 0 && <Line data={chartData} options={chartOptions} />}
      </div>
    </MetricCard>
  );
}
