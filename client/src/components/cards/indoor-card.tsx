import { useMemo, type ReactNode } from "react";
import { Line } from "react-chartjs-2";
import { Maximize2 } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";
import { useFlash } from "@/hooks/use-flash";
import { useUnits } from "@/hooks/use-units";
import { fmt, getStatus } from "@/constants/thresholds";
import { convertTemp } from "@/constants/units";
import { getBucketMs, bucketAverage, expandedChartOptions } from "@/constants/chart-utils";
import type { WeatherReading, AirReading, OpenOverlayFn, TimeRange } from "@/types/api";

const statusLevelColors: Record<string, string> = {
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

// Map temp metric key to its corresponding humidity key
const HUMIDITY_KEY_MAP: Record<string, string> = {
  temp_indoor_c: "humidity_indoor",
  temp_ch8_c: "humidity_ch8",
  temperature: "humidity",
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
  openOverlay: OpenOverlayFn;
}

function ExpandedIndoorChart({
  range,
  weatherHistory,
  airHistory,
  metricKey,
  humidityKey,
  isAirSource,
}: {
  range: TimeRange;
  weatherHistory: WeatherReading[];
  airHistory: AirReading[];
  metricKey: string;
  humidityKey: string;
  isAirSource: boolean;
}) {
  const { tempLabel, units: { temperature: tempUnit } } = useUnits();
  const bMs = getBucketMs(range);
  const history = isAirSource ? airHistory : weatherHistory;

  const tempData = useMemo(
    () => bucketAverage(history as (WeatherReading & AirReading)[], metricKey as keyof (WeatherReading & AirReading), bMs)
      .map(p => ({ ...p, y: convertTemp(p.y, tempUnit) })),
    [history, metricKey, bMs, tempUnit],
  );
  const humData = useMemo(
    () => bucketAverage(history as (WeatherReading & AirReading)[], humidityKey as keyof (WeatherReading & AirReading), bMs),
    [history, humidityKey, bMs],
  );

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
      y2: {
        position: "right" as const,
        title: { display: true, text: "%", color: "#8b5cf6", font: { size: 11 } },
        grid: { drawOnChartArea: false },
        ticks: { color: "#8b5cf6", font: { size: 11 } },
        min: 0,
        max: 100,
      },
    },
  };

  return <div className="h-full"><Line data={data} options={options} /></div>;
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
  openOverlay,
}: IndoorCardProps) {
  const { fmtTemp, tempLabel, units: { temperature: tempUnit } } = useUnits();
  const flash = useFlash(temp != null ? fmtTemp(temp) : null);
  const noiseStatus = noise !== undefined ? getStatus("noise", noise) : null;

  const hourlyData = useMemo(() => {
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
      .map(([ts, d]) => ({ x: new Date(ts).toISOString(), y: convertTemp(d.sum / d.count, tempUnit) }))
      .sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());
  }, [history, metricKey, tempUnit]);

  const chartData = {
    datasets: [
      {
        data: hourlyData,
        borderColor: "#00d4ff",
        backgroundColor: "rgba(0, 212, 255, 0.15)",
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
        ticks: { color: "#7a8ba8", font: { size: 10 }, maxTicksLimit: 5 },
      },
    },
    elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 4 } },
    interaction: { intersect: false, mode: "index" as const },
  };

  const isAirSource = metricKey === "temperature";
  const humidityKey = metricKey ? HUMIDITY_KEY_MAP[metricKey as string] || "humidity" : "humidity";

  const handleExpand = () => {
    if (!metricKey) return;
    openOverlay(`${title} — Indoor`, (range, wh, ah) => (
      <ExpandedIndoorChart
        range={range}
        weatherHistory={wh}
        airHistory={ah}
        metricKey={metricKey as string}
        humidityKey={humidityKey}
        isAirSource={isAirSource}
      />
    ));
  };

  return (
    <MetricCard flash={flash} className="p-4 pb-0 flex flex-col">
      <div className="flex flex-col z-10 w-full mb-[100px]">
        <h3 className="text-[0.95rem] font-medium text-text mb-2">{title}</h3>

        <div className="flex items-baseline gap-3 md:gap-5">
          <div className="flex flex-col">
            <span className="text-2xl md:text-3xl font-semibold leading-none tracking-tight text-cyan">
              {fmtTemp(temp)}<span className="text-xl">{tempLabel}</span>
            </span>
            <span className="text-[0.75rem] text-text font-medium mt-1">Temp.</span>
          </div>

          <div className="flex flex-col">
            <span className="text-2xl md:text-3xl font-semibold leading-none tracking-tight text-cyan">
              {fmt(humidity, 0)}<span className="text-xl">%</span>
            </span>
            <span className="text-[0.75rem] text-text font-medium mt-1">Humidity</span>
          </div>

          {dewPoint != null && (
            <div className="flex flex-col ml-auto">
              <span className="text-lg font-semibold leading-none tracking-tight text-[#94a3b8]">
                {fmtTemp(dewPoint)}<span className="text-sm">{tempLabel}</span>
              </span>
              <span className="text-[0.75rem] text-text font-medium mt-1">Dew Point</span>
            </div>
          )}

          {feelsLike != null && (
            <div className="flex flex-col">
              <span className="text-lg font-semibold leading-none tracking-tight text-[#94a3b8]">
                {fmtTemp(feelsLike)}<span className="text-sm">{tempLabel}</span>
              </span>
              <span className="text-[0.75rem] text-text font-medium mt-1">Feels Like</span>
            </div>
          )}

          {noise !== undefined && noiseStatus && (
            <div className="flex flex-col ml-auto">
              <span className="text-lg font-semibold leading-none tracking-tight text-[#94a3b8]">
                {noise ?? "--"}<span className="text-sm"> dB</span>
              </span>
              <span
                className="text-[0.75rem] font-medium mt-1"
                style={{ color: noiseStatus.level ? statusLevelColors[noiseStatus.level] : "#7a8ba8" }}
              >
                {noiseStatus.label}
              </span>
            </div>
          )}
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
