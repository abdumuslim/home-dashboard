import type { TimeRange } from "@/types/api";

/** Range-adaptive bucket size in milliseconds */
export function getBucketMs(range: TimeRange): number {
  switch (range) {
    case "6h": return 5 * 60_000;      // 5 min
    case "24h": return 5 * 60_000;      // 5 min
    case "25h": return 5 * 60_000;      // 5 min
    case "48h": return 5 * 60_000;      // 5 min
    case "1w": return 60 * 60_000;      // 1 hr
    case "30d": return 3 * 60 * 60_000; // 3 hr (server returns hourly, aggregate further)
  }
}

/** Generic bucket-average for any numeric field in an array of records */
export function bucketAverage<T extends { ts: string }>(
  data: T[],
  field: keyof T,
  bucketMs: number,
): { x: string; y: number }[] {
  const buckets = new Map<number, { sum: number; count: number }>();
  for (const r of data) {
    const val = r[field];
    if (val == null) continue;
    const ts = new Date(r.ts).getTime();
    const key = Math.floor(ts / bucketMs) * bucketMs;
    const b = buckets.get(key) || { sum: 0, count: 0 };
    b.sum += val as number;
    b.count += 1;
    buckets.set(key, b);
  }
  return Array.from(buckets.entries())
    .map(([ts, d]) => ({ x: new Date(ts).toISOString(), y: d.sum / d.count }))
    .sort((a, b) => a.x.localeCompare(b.x));
}

/** Generic bucket-median for any numeric field */
export function bucketMedian<T extends { ts: string }>(
  data: T[],
  field: keyof T,
  bucketMs: number,
): { x: string; y: number }[] {
  const buckets = new Map<number, number[]>();
  for (const r of data) {
    const val = r[field];
    if (val == null) continue;
    const ts = new Date(r.ts).getTime();
    const key = Math.floor(ts / bucketMs) * bucketMs;
    const arr = buckets.get(key) || [];
    arr.push(val as number);
    buckets.set(key, arr);
  }
  return Array.from(buckets.entries())
    .map(([ts, vals]) => {
      vals.sort((a, b) => a - b);
      const mid = Math.floor(vals.length / 2);
      const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
      return { x: new Date(ts).toISOString(), y: median };
    })
    .sort((a, b) => a.x.localeCompare(b.x));
}

/** Generic bucket-max for any numeric field */
export function bucketMax<T extends { ts: string }>(
  data: T[],
  field: keyof T,
  bucketMs: number,
): { x: string; y: number }[] {
  const buckets = new Map<number, number>();
  for (const r of data) {
    const val = r[field];
    if (val == null) continue;
    const ts = new Date(r.ts).getTime();
    const key = Math.floor(ts / bucketMs) * bucketMs;
    const cur = buckets.get(key);
    buckets.set(key, cur == null ? (val as number) : Math.max(cur, val as number));
  }
  return Array.from(buckets.entries())
    .map(([ts, y]) => ({ x: new Date(ts).toISOString(), y }))
    .sort((a, b) => a.x.localeCompare(b.x));
}

/** Range-adaptive x-axis time scale + tick config */
function getXAxisConfig(range: TimeRange) {
  switch (range) {
    case "6h":
      return {
        time: { unit: "hour" as const, stepSize: 1, displayFormats: { hour: "ha" } },
        ticks: { color: "#7a8ba8", font: { size: 11 }, maxRotation: 0, autoSkip: false },
      };
    case "24h":
      return {
        time: { unit: "hour" as const, stepSize: 2, displayFormats: { hour: "ha" } },
        ticks: { color: "#7a8ba8", font: { size: 11 }, maxRotation: 0, autoSkip: false },
      };
    case "48h":
      return {
        time: { unit: "hour" as const, stepSize: 4, displayFormats: { hour: "ha" } },
        ticks: { color: "#7a8ba8", font: { size: 11 }, maxRotation: 0, autoSkip: false },
      };
    case "1w":
      return {
        time: { unit: "day" as const, stepSize: 1, displayFormats: { day: "EEE d" } },
        ticks: { color: "#7a8ba8", font: { size: 11 }, maxRotation: 0, autoSkip: false },
      };
    case "30d":
      return {
        time: { unit: "day" as const, displayFormats: { day: "MMM d" } },
        ticks: { color: "#7a8ba8", font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
      };
  }
}

/** Shared base chart options for expanded overlays */
export function expandedChartOptions(range: TimeRange, yLabel?: string) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        backgroundColor: "rgba(15, 20, 35, 0.9)",
        borderColor: "rgba(255,255,255,0.1)",
        borderWidth: 1,
        titleColor: "#e0e0e0",
        bodyColor: "#e0e0e0",
        padding: 10,
        cornerRadius: 8,
        titleFont: { size: 12 },
        bodyFont: { size: 13 },
      },
    },
    scales: {
      x: {
        type: "time" as const,
        ...getXAxisConfig(range),
        grid: { color: "rgba(255,255,255,0.04)" },
      },
      y: {
        position: "left" as const,
        title: yLabel ? { display: true, text: yLabel, color: "#7a8ba8", font: { size: 11 } } : { display: false },
        grid: { color: "rgba(255,255,255,0.06)" },
        ticks: { color: "#7a8ba8", font: { size: 11 } },
      },
    },
    interaction: {
      intersect: false,
      mode: "index" as const,
    },
    elements: {
      point: { radius: 0, hitRadius: 12, hoverRadius: 4, hoverBorderWidth: 2 },
    },
  };
}
