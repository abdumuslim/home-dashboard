import { useState } from "react";
import { Line, Bar } from "react-chartjs-2";
import type { ChartOptions } from "chart.js";
import type { TimeRange } from "@/types/api";
import { useHistoryData } from "@/hooks/use-history-data";
import { createChartOptions } from "@/charts/chart-config";
import { ChartContainer } from "@/charts/chart-container";
import { RangeSelector } from "@/charts/range-selector";

function xy<T>(data: T[], field: keyof T) {
  return data
    .filter((r) => r[field] != null)
    .map((r) => ({ x: r["ts" as keyof T] as string, y: r[field] as number }));
}

export function ChartsTab() {
  const [range, setRange] = useState<TimeRange>("24h");
  const { weatherHistory, airHistory } = useHistoryData(range, true);

  const tempData = {
    datasets: [
      { label: "Outdoor", borderColor: "#ff9800", data: xy(weatherHistory, "temp_c") },
      { label: "Indoor", borderColor: "#4a9eff", data: xy(weatherHistory, "temp_indoor_c") },
      { label: "Abdu", borderColor: "#b388ff", data: xy(weatherHistory, "temp_ch8_c") },
      { label: "Air Mon", borderColor: "#4caf50", data: xy(airHistory, "temperature") },
    ],
  };

  const humidityData = {
    datasets: [
      { label: "Outdoor", borderColor: "#00d4ff", data: xy(weatherHistory, "humidity") },
      { label: "Indoor", borderColor: "#8b5cf6", data: xy(weatherHistory, "humidity_indoor") },
      { label: "Abdu", borderColor: "#b388ff", data: xy(weatherHistory, "humidity_ch8") },
      { label: "Air Mon", borderColor: "#4caf50", data: xy(airHistory, "humidity") },
    ],
  };

  const airQualityOptions: ChartOptions<"line"> = {
    ...createChartOptions("Air Quality"),
    scales: {
      ...createChartOptions("Air Quality").scales,
      y: {
        title: { display: true, text: "CO\u2082 ppm", color: "#7a8ba8", font: { size: 11 } },
        ticks: { color: "#7a8ba8", font: { size: 11 } },
        grid: { color: "#1e2f50" },
      },
      y2: {
        position: "right",
        title: { display: true, text: "\u00B5g/m\u00B3", color: "#7a8ba8", font: { size: 11 } },
        ticks: { color: "#7a8ba8", font: { size: 11 } },
        grid: { drawOnChartArea: false },
      },
    },
  };

  const airData = {
    datasets: [
      { label: "CO\u2082", borderColor: "#ffc107", data: xy(airHistory, "co2"), yAxisID: "y" },
      { label: "PM2.5", borderColor: "#ff5252", data: xy(airHistory, "pm25"), yAxisID: "y2" },
      { label: "PM10", borderColor: "#ff9800", data: xy(airHistory, "pm10"), yAxisID: "y2" },
    ],
  };

  const windData = {
    datasets: [
      { label: "Speed", borderColor: "#4caf50", data: xy(weatherHistory, "wind_speed_kmh") },
      {
        label: "Gust",
        borderColor: "#4caf5050",
        borderDash: [4, 4],
        data: xy(weatherHistory, "wind_gust_kmh"),
      },
    ],
  };

  const pressureData = {
    datasets: [
      { label: "Pressure", borderColor: "#b388ff", data: xy(weatherHistory, "pressure_rel_hpa") },
    ],
  };

  const rainData = {
    datasets: [
      {
        label: "Hourly Rain",
        backgroundColor: "#4a9eff80",
        borderColor: "#4a9eff",
        borderWidth: 1,
        data: xy(weatherHistory, "rain_hourly_mm"),
      },
    ],
  };

  return (
    <div className="max-w-[1440px] mx-auto px-5 pt-4 pb-8 max-md:px-3">
      <RangeSelector current={range} onChange={setRange} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <ChartContainer>
          <Line data={tempData} options={createChartOptions("Temperature", "\u00B0C")} />
        </ChartContainer>
        <ChartContainer>
          <Line data={humidityData} options={createChartOptions("Humidity", "%")} />
        </ChartContainer>
        <ChartContainer>
          <Line data={airData} options={airQualityOptions} />
        </ChartContainer>
        <ChartContainer>
          <Line data={windData} options={createChartOptions("Wind", "km/h")} />
        </ChartContainer>
        <ChartContainer>
          <Line data={pressureData} options={createChartOptions("Barometric Pressure", "hPa")} />
        </ChartContainer>
        <ChartContainer>
          <Bar
            data={rainData}
            options={createChartOptions("Rainfall", "mm") as ChartOptions<"bar">}
          />
        </ChartContainer>
      </div>
    </div>
  );
}
