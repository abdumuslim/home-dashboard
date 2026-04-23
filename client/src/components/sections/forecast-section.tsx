import { memo, useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Chart } from "react-chartjs-2";
import type { ForecastResponse } from "@/types/forecast";
import { getWeatherIcon, getWeatherLabel, getDayLabel } from "@/constants/forecast-utils";
import { getTempColor } from "@/constants/thresholds";

interface ForecastSectionProps {
  forecast: ForecastResponse | null;
}

/** Extract hourly indices for a given day date string (YYYY-MM-DD) */
function getHourlyIndicesForDay(times: string[], dateStr: string): number[] {
  const indices: number[] = [];
  for (let i = 0; i < times.length; i++) {
    if (times[i].startsWith(dateStr)) indices.push(i);
  }
  return indices;
}

/** Format hour number to "12 AM", "3 PM", etc. */
function formatHour(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/** Get precip bar color based on probability */
function precipColor(pct: number): string {
  if (pct <= 0) return "transparent";
  if (pct < 30) return "rgba(56, 189, 248, 0.2)";
  if (pct < 60) return "rgba(56, 189, 248, 0.45)";
  return "rgba(56, 189, 248, 0.8)";
}

export const ForecastSection = memo(function ForecastSection({ forecast }: ForecastSectionProps) {
  const [selectedDay, setSelectedDay] = useState(0);
  const stripRef = useRef<HTMLDivElement>(null);

  // Reset selection when forecast updates with different dates
  useEffect(() => {
    setSelectedDay(0);
  }, [forecast?.daily?.date?.[0]]);

  const selectDay = useCallback((i: number) => setSelectedDay(i), []);

  if (!forecast?.daily?.date?.length) {
    return (
      <div className="text-dim text-sm py-4 text-center">Loading forecast...</div>
    );
  }

  const { daily, hourly } = forecast;

  // Hourly data for the selected day
  const hourlyIndices = getHourlyIndicesForDay(hourly.time, daily.date[selectedDay]);

  // Sunrise/sunset for selected day — used to determine night icons
  const sunriseStr = daily.sunrise[selectedDay];
  const sunsetStr = daily.sunset[selectedDay];
  const sunriseHour = sunriseStr ? parseInt(sunriseStr.split(":")[0], 10) + parseInt(sunriseStr.split(":")[1], 10) / 60 : null;
  const sunsetHour = sunsetStr ? parseInt(sunsetStr.split(":")[0], 10) + parseInt(sunsetStr.split(":")[1], 10) / 60 : null;

  return (
    <div className="glass-card p-4 flex flex-col gap-4">
      {/* === Zone 1: Daily Strip === */}
      <div
        ref={stripRef}
        className="flex md:grid md:grid-cols-7 gap-2 overflow-x-auto pb-1 scrollbar-hide w-full"
      >
        {daily.date.map((date, i) => {
          const isSelected = i === selectedDay;
          const tMax = daily.temp_max[i];
          const tMin = daily.temp_min[i];
          const dateNum = date.slice(8, 10).replace(/^0/, "");

          return (
            <button
              key={date}
              onClick={() => selectDay(i)}
              className={`flex flex-col items-center justify-between gap-1.5 px-2 py-3 rounded-xl min-w-[75px] shrink-0 cursor-pointer
                transition-all duration-300 border
                ${isSelected
                  ? "bg-cyan/10 border-cyan/40 shadow-[0_0_15px_rgba(34,211,238,0.05)]"
                  : "bg-surface/40 border-transparent hover:bg-surface/60 hover:border-white/10"
                }`}
            >
              {/* Day label + Date number row for compactness */}
              <div className="flex flex-col items-center gap-0.5 w-full">
                <span className={`text-[0.65rem] uppercase tracking-wider font-bold ${isSelected ? "text-cyan" : "text-dim"}`}>
                  {getDayLabel(date, i)}
                </span>
                <span className={`text-[1.1rem] font-bold leading-none ${isSelected ? "text-white" : "text-text"}`}>
                  {dateNum}
                </span>
              </div>

              {/* Weather icon */}
              <img
                src={getWeatherIcon(daily.weather_code[i])}
                alt={getWeatherLabel(daily.weather_code[i])}
                className="w-9 h-9 my-0.5"
                loading="lazy"
              />

              {/* Hi / Lo */}
              <div className="flex items-baseline gap-1.5">
                <span
                  className="text-[0.9rem] font-semibold leading-none"
                  style={{ color: getTempColor(tMax) }}
                >
                  {tMax != null ? Math.round(tMax) : "--"}°
                </span>
                <span className="text-[0.7rem] text-dim font-medium">
                  {tMin != null ? Math.round(tMin) : "--"}°
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* === Zone 2: Hourly Detail === */}
      <HourlyDetail
        hourly={hourly}
        indices={hourlyIndices}
        sunriseHour={sunriseHour}
        sunsetHour={sunsetHour}
      />
    </div>
  );
});

/** Hourly detail sub-component — memoized to avoid re-renders when parent state changes */
/** Hourly detail sub-component — memoized to avoid re-renders when parent state changes */
const HourlyDetail = memo(function HourlyDetail({
  hourly,
  indices,
  sunriseHour,
  sunsetHour,
}: {
  hourly: ForecastResponse["hourly"];
  indices: number[];
  sunriseHour: number | null;
  sunsetHour: number | null;
}) {
  if (indices.length === 0) return null;

  // Determine if each hour is nighttime
  const isNightHour = (h: number) => {
    if (sunriseHour == null || sunsetHour == null) return false;
    return h < sunriseHour || h >= sunsetHour;
  };

  // Chart data: full 24-hour mixed chart (Temperature Line + Precipitation Bar)
  const chartData = useMemo(() => {
    const labels = indices.map((gi) => {
      const hour = parseInt(hourly.time[gi].slice(11, 13), 10);
      return formatHour(hour);
    });

    const temps = indices.map((gi) => hourly.temperature[gi]);
    const precips = indices.map((gi) => hourly.precip_probability[gi] ?? 0);

    return {
      labels,
      datasets: [
        {
          type: "line" as const,
          label: "Temperature",
          data: temps,
          borderColor: "#00d4ff",
          backgroundColor: "rgba(0, 212, 255, 0.12)",
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.4,
          cubicInterpolationMode: "monotone" as const,
          yAxisID: "y",
          order: 1,
        },
        {
          type: "bar" as const,
          label: "Precipitation",
          data: precips,
          backgroundColor: precips.map(p => precipColor(p)),
          barPercentage: 1.0,
          categoryPercentage: 1.0,
          yAxisID: "yPrecip",
          order: 2,
        }
      ],
    };
  }, [indices, hourly.time, hourly.temperature, hourly.precip_probability]);

  const tempsArray = chartData.datasets[0].data as number[];
  const minTemp = Math.min(...tempsArray.filter(t => t != null));
  const maxTemp = Math.max(...tempsArray.filter(t => t != null));
  const tempPadding = Math.max((maxTemp - minTemp) * 0.6, 3); // Extra padding to prevent bezier curve from clipping top/bottom

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    layout: {
      padding: { left: 8, right: 8, top: 12, bottom: 0 } // Subtly pad the chart so curves have breathing room
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        mode: "index" as const,
        intersect: false,
        callbacks: {
          label: (item: any) => {
            if (item.dataset.label === "Temperature") return `${Math.round(item.raw)}°C`;
            if (item.dataset.label === "Precipitation") return `${item.raw}% Precip`;
            return `${item.raw}`;
          },
        },
      },
    },
    scales: {
      x: {
        type: "category" as const,
        display: false,
        grid: { display: false },
        offset: true,
      },
      y: {
        display: false,
        min: minTemp - tempPadding,
        max: maxTemp + tempPadding,
      },
      yPrecip: {
        display: false,
        position: "right" as const,
        min: 0,
        max: 300, // Forces the 0-100% precip bars to only occupy the bottom third of the chart
      },
    },
    elements: { point: { radius: 0, hitRadius: 15, hoverRadius: 4, hoverBorderColor: "#00d4ff" } },
    interaction: { intersect: false, mode: "index" as const },
  }), [minTemp, maxTemp, tempPadding]);

  return (
    <div className="flex flex-col gap-0 relative mt-3 px-2">
      {/* Hourly icon strip (Grid perfectly aligned with Chart Category scale) */}
      <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] w-full mb-[-15px] z-10 relative pointer-events-none px-2">
        {indices.map((gi, localIdx) => {
          // Show label/icon every 3 hours
          if (localIdx % 3 !== 0) {
            return <div key={gi} />;
          }

          const hour = parseInt(hourly.time[gi].slice(11, 13), 10);
          const temp = hourly.temperature[gi];
          const code = hourly.weather_code[gi];
          const night = isNightHour(hour);

          return (
            <div key={gi} className="flex flex-col items-center gap-1.5 w-[44px] -ml-[22px] left-[50%] relative py-1">
              <span className="text-[0.65rem] text-dim/80 font-medium tracking-wide">{formatHour(hour)}</span>
              <img
                src={getWeatherIcon(code, night)}
                alt={getWeatherLabel(code)}
                className="w-6 h-6 filter drop-shadow-md opacity-90"
                loading="lazy"
              />
              <span
                className="text-[0.7rem] font-bold drop-shadow-sm transition-colors duration-300"
                style={{ color: getTempColor(temp) }}
              >
                {temp != null ? Math.round(temp) : "--"}°
              </span>
            </div>
          );
        })}
      </div>

      {/* Mixed Chart (Line + Bar) */}
      <div className="h-[150px] w-full relative -mx-1">
        <Chart type="line" data={chartData} options={chartOptions as any} />
      </div>
    </div>
  );
});
