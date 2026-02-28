import type { ChartOptions } from "chart.js";

export function createChartOptions(title: string, yUnit?: string): ChartOptions<"line"> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    interaction: { mode: "index", intersect: false },
    scales: {
      x: {
        type: "time",
        time: {
          unit: "hour",
          displayFormats: { hour: "h" },
          tooltipFormat: "MMM d, h:mm a"
        },
        ticks: {
          color: "#7a8ba8",
          maxTicksLimit: 24,
          stepSize: 1,
          font: { size: 11 },
          maxRotation: 0,
          autoSkip: false
        },
        grid: { color: "#1e2f50" },
      },
      y: {
        ticks: { color: "#7a8ba8", font: { size: 11 } },
        grid: { color: "#1e2f50" },
        ...(yUnit
          ? { title: { display: true, text: yUnit, color: "#7a8ba8", font: { size: 11 } } }
          : {}),
      },
    },
    plugins: {
      legend: {
        labels: { color: "#9ca3af", boxWidth: 10, padding: 10, font: { size: 11 } },
      },
      title: {
        display: true,
        text: title,
        color: "#9ca3af",
        font: { size: 12, weight: 500 },
        padding: { bottom: 6 },
      },
    },
    elements: {
      point: { radius: 0, hoverRadius: 4 },
      line: { borderWidth: 2, tension: 0.3 },
    },
  };
}
