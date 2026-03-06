import { useState, useMemo, type ReactNode } from "react";
import { Line } from "react-chartjs-2";
import { Maximize2, Power, Fan, Settings, Loader2, Hourglass } from "lucide-react";
import { cn } from "@/lib/utils";
import { MetricCard } from "@/components/ui/metric-card";
import { PurifierDetailOverlay } from "@/components/ui/purifier-detail-overlay";
import { useFlash } from "@/hooks/use-flash";
import { useUnits } from "@/hooks/use-units";
import { useChartsVisible } from "@/hooks/use-charts-visible";
import { fmt, getStatus, getTempGradientStyle } from "@/constants/thresholds";
import { convertTemp } from "@/constants/units";
import { getBucketMs, bucketAverage, expandedChartOptions } from "@/constants/chart-utils";
import type { WeatherReading, AirReading, OpenOverlayFn, TimeRange } from "@/types/api";
import type { PurifierDevice } from "@/types/automations";

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
  device?: PurifierDevice;
  onControl?: (command: string, params: unknown[]) => Promise<void>;
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
  device,
  onControl,
}: IndoorCardProps) {
  const { fmtTemp, tempLabel, units: { temperature: tempUnit } } = useUnits();
  const { chartsVisible } = useChartsVisible();
  const flash = useFlash(temp != null ? fmtTemp(temp) : null);
  const noiseStatus = noise !== undefined ? getStatus("noise", noise) : null;
  const [showDetail, setShowDetail] = useState(false);
  const [powerBusy, setPowerBusy] = useState(false);

  const handlePowerToggle = async () => {
    if (!device || !onControl || !device.isOnline) return;
    setPowerBusy(true);
    try { await onControl("set_power", [device.power === "on" ? "off" : "on"]); } finally { setPowerBusy(false); }
  };

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

  const isOn = device?.power === "on";
  const offline = device != null && !device.isOnline;
  const filterLow = device?.filter_life != null && device.filter_life <= 20;
  const hasPurifier = device != null && onControl != null;

  return (
    <MetricCard flash={flash} className="p-4 pb-0 flex flex-col">
      <div className={`flex z-10 w-full transition-[margin] duration-300 ${chartsVisible ? "mb-[100px]" : "mb-3"} gap-3`}>
        {/* Left: main content */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Title */}
          <h3 className="text-[0.95rem] font-medium text-text mb-2 mt-1">{title}</h3>

          {/* Main Weather Data */}
          <div className="flex items-baseline gap-3 md:gap-5 mt-1">
            <div className="flex flex-col">
              <span className="text-2xl md:text-3xl font-semibold leading-none tracking-tight" style={getTempGradientStyle(temp)}>
                {fmtTemp(temp)}<span className="text-xl">{tempLabel}</span>
              </span>
              <span className="text-[0.75rem] text-text font-medium mt-1">Temp.</span>
            </div>

            {feelsLike != null && (
              <div className="flex flex-col">
                <span className="text-xl md:text-2xl font-semibold leading-none tracking-tight text-white">
                  {fmtTemp(feelsLike)}<span className="text-base">{tempLabel}</span>
                </span>
                <span className="text-[0.75rem] text-text font-medium mt-1">Feels like</span>
              </div>
            )}

            <div className="flex flex-col">
              <span className="text-2xl md:text-3xl font-semibold leading-none tracking-tight text-cyan">
                {fmt(humidity, 0)}<span className="text-xl">%</span>
              </span>
              <span className="text-[0.75rem] text-text font-medium mt-1">Humidity</span>
            </div>

            {/* Noise (Kitchen only) */}
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

          {/* Secondary Info Row */}
          {dewPoint != null && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim mt-4">
              <span>Dew Point <span className="text-text font-medium">{fmtTemp(dewPoint)}{tempLabel}</span></span>
            </div>
          )}
        </div>

        {/* Right: purifier controls — vertical capsule */}
        {hasPurifier && (
          <div className={cn(
            "flex flex-col items-center bg-[#171920]/90 border border-white/[0.05] p-1 rounded-2xl shadow-[0_4px_12px_-4px_rgba(0,0,0,0.5)] backdrop-blur-xl transition-all shrink-0 self-start",
            offline ? "opacity-40" : "hover:border-white/10 hover:bg-[#1a1c23]/95"
          )}>
            {/* Row 1: Power + Settings */}
            <div className="flex items-center gap-1">
              <button
                onClick={handlePowerToggle}
                disabled={offline || powerBusy}
                className={cn(
                  "relative flex items-center justify-center w-7 h-7 rounded-full transition-all shrink-0",
                  isOn
                    ? "bg-emerald-500 text-black hover:bg-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.3)]"
                    : "bg-white/[0.03] text-dim hover:bg-white/10 hover:text-white",
                  (offline || powerBusy) && "cursor-not-allowed",
                )}
                title={offline ? "Offline" : isOn ? "Turn off" : "Turn on"}
              >
                {powerBusy
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Power className="w-3.5 h-3.5" strokeWidth={2.5} />
                }
              </button>
              <button
                onClick={() => setShowDetail(true)}
                className="flex items-center justify-center w-7 h-7 rounded-full text-dim hover:text-white hover:bg-white/10 transition-colors shrink-0"
                title="Purifier settings"
              >
                <Settings className="w-4 h-4" />
              </button>
            </div>

            <div className="h-[1px] w-3/4 bg-white/[0.08] my-1" />

            {/* Row 2: AQI Status */}
            {(() => {
              const aqiStatus = device!.isOnline && device!.aqi != null ? getStatus("pm25", device!.aqi) : null;
              const aqiColor = aqiStatus?.level ? statusLevelColors[aqiStatus.level] : undefined;
              return (
                <div
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-colors h-7",
                    isOn ? "shadow-inner" : "bg-white/[0.03] text-dim"
                  )}
                  style={isOn ? { backgroundColor: aqiColor ? `${aqiColor}15` : "rgba(16,185,129,0.15)", color: aqiColor || "#34d399" } : undefined}
                >
                  <Fan className={cn("w-3.5 h-3.5", isOn && "animate-[spin_3s_linear_infinite]")} />
                  {aqiStatus ? (
                    <span className="text-[0.7rem] font-bold text-text ml-0.5 tracking-wide flex items-baseline gap-1">
                      {device!.aqi} <span className="text-[0.55rem] text-dim font-bold uppercase">AQI</span>
                    </span>
                  ) : (
                    <span className="text-[0.65rem] font-semibold tracking-wider uppercase flex items-center h-full">Purifier</span>
                  )}
                </div>
              );
            })()}

            {/* Row 3: Filter bar capsule (only if available) */}
            {device!.isOnline && device!.filter_life != null && (
              <>
                <div className="h-[1px] w-3/4 bg-white/[0.08] my-1" />
                <div
                  className="relative h-5 w-full rounded-full overflow-hidden bg-black/30 mx-1 my-0.5"
                  title={`Filter: ${device!.filter_life}%`}
                >
                  <div
                    className={cn(
                      "absolute inset-y-0 left-0 rounded-full transition-all duration-1000 ease-out",
                      filterLow ? "bg-red-500/40" : "bg-emerald-500/25"
                    )}
                    style={{ width: `${Math.max(0, device!.filter_life!)}%` }}
                  />
                  <div className="relative flex items-center justify-center h-full gap-1 px-2">
                    <Hourglass className={cn(
                      "w-3 h-3 shrink-0",
                      filterLow ? "text-red-400" : "text-emerald-400"
                    )} />
                    <span className={cn(
                      "text-[0.6rem] font-bold tabular-nums tracking-tight",
                      filterLow ? "text-red-400" : "text-emerald-400"
                    )}>
                      {device!.filter_life}%
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div
        className={`absolute bottom-0 left-0 right-0 h-[100px] w-full px-2 pb-1 z-0 rounded-b-xl overflow-hidden group cursor-pointer transition-opacity duration-300 ${chartsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={handleExpand}
      >
        <div className="absolute top-1 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
          <Maximize2 className="w-3.5 h-3.5 text-dim" />
        </div>
        {hourlyData.length > 0 && <Line data={chartData} options={chartOptions} />}
      </div>

      {showDetail && device && onControl && (
        <PurifierDetailOverlay
          device={device as PurifierDevice}
          onControl={onControl}
          onClose={() => setShowDetail(false)}
        />
      )}
    </MetricCard>
  );
}
