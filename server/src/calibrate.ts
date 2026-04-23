/**
 * Calibration script — run once on dev PC to generate bias-table.json
 * Usage: npx tsx server/src/calibrate.ts
 *
 * Parses local weather station CSV, fetches Open-Meteo archive for the same period,
 * aligns by hour, and computes per-metric per-month per-hour bias corrections.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_PATH = path.resolve(__dirname, "../../docs/Backup-A.CSV");
const OUTPUT_PATH = path.resolve(__dirname, "../data/bias-table.json");

const LAT = 33.3215;
const LON = 44.3583;
const TZ = "Asia/Baghdad"; // UTC+3, no DST
const MPH_TO_KMH = 1.60934;

interface HourlyBucket {
  temp: number[];
  humidity: number[];
  wind_speed: number[];
  solar_radiation: number[];
}

// Parse CSV and group into hourly averages (Baghdad local time)
function parseCSV(csvPath: string): Map<string, HourlyBucket> {
  const raw = fs.readFileSync(csvPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  // Skip header
  const data = lines.slice(1);

  // Map key: "YYYY-MM-DDTHH" in Baghdad local time
  const buckets = new Map<string, HourlyBucket>();

  for (const line of data) {
    const cols = line.split(",");
    if (cols.length < 8) continue;

    const timeStr = cols[0].trim(); // "2025/8/31 13:15"
    const tempC = parseFloat(cols[3]); // Outdoor Temperature(℃)
    const humPct = parseFloat(cols[4]); // Outdoor Humidity(%)
    const windMph = parseFloat(cols[6]); // Wind(mph)
    const solarWm2 = parseFloat(cols[12]); // Solar Rad.(w/m2)

    if (isNaN(tempC) || isNaN(humPct) || isNaN(windMph) || isNaN(solarWm2)) continue;

    // Parse Baghdad local time directly (CSV is already in local time)
    const match = timeStr.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (!match) continue;
    const [, year, month, day, hour] = match;
    const key = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { temp: [], humidity: [], wind_speed: [], solar_radiation: [] };
      buckets.set(key, bucket);
    }
    bucket.temp.push(tempC);
    bucket.humidity.push(humPct);
    bucket.wind_speed.push(windMph * MPH_TO_KMH);
    bucket.solar_radiation.push(solarWm2);
  }

  return buckets;
}

function mean(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

async function fetchOpenMeteoArchive(startDate: string, endDate: string) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}&start_date=${startDate}&end_date=${endDate}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,shortwave_radiation&timezone=${TZ}`;
  console.log(`Fetching Open-Meteo archive: ${startDate} to ${endDate}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo archive API error: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{
    hourly: {
      time: string[];
      temperature_2m: (number | null)[];
      relative_humidity_2m: (number | null)[];
      wind_speed_10m: (number | null)[];
      shortwave_radiation: (number | null)[];
    };
  }>;
}

async function main() {
  console.log("Parsing CSV...");
  const stationBuckets = parseCSV(CSV_PATH);
  console.log(`  ${stationBuckets.size} hourly buckets from station data`);

  // Determine date range from station data
  const keys = [...stationBuckets.keys()].sort();
  const startDate = keys[0].slice(0, 10);
  const endDate = keys[keys.length - 1].slice(0, 10);
  console.log(`  Date range: ${startDate} to ${endDate}`);

  // Fetch Open-Meteo archive
  const archive = await fetchOpenMeteoArchive(startDate, endDate);
  const omTimes = archive.hourly.time;
  const omTemp = archive.hourly.temperature_2m;
  const omHumidity = archive.hourly.relative_humidity_2m;
  const omWind = archive.hourly.wind_speed_10m;
  const omSolar = archive.hourly.shortwave_radiation;

  // Build OM lookup: key "YYYY-MM-DDTHH" → values
  const omMap = new Map<string, { temp: number; humidity: number; wind_speed: number; solar_radiation: number }>();
  for (let i = 0; i < omTimes.length; i++) {
    const t = omTimes[i]; // "2025-08-31T13:00"
    const key = t.slice(0, 13); // "2025-08-31T13"
    if (omTemp[i] == null || omHumidity[i] == null || omWind[i] == null || omSolar[i] == null) continue;
    omMap.set(key, {
      temp: omTemp[i]!,
      humidity: omHumidity[i]!,
      wind_speed: omWind[i]!,
      solar_radiation: omSolar[i]!,
    });
  }
  console.log(`  ${omMap.size} hourly entries from Open-Meteo archive`);

  // Compute bias: bias[metric][month 0-11][hour 0-23] = array of (station - openmeteo)
  type MetricName = "temperature" | "humidity" | "wind_speed" | "solar_radiation";
  const metrics: MetricName[] = ["temperature", "humidity", "wind_speed", "solar_radiation"];
  const biasArrays: Record<MetricName, number[][][]> = {
    temperature: Array.from({ length: 12 }, () => Array.from({ length: 24 }, () => [])),
    humidity: Array.from({ length: 12 }, () => Array.from({ length: 24 }, () => [])),
    wind_speed: Array.from({ length: 12 }, () => Array.from({ length: 24 }, () => [])),
    solar_radiation: Array.from({ length: 12 }, () => Array.from({ length: 24 }, () => [])),
  };

  let matched = 0;
  for (const [key, bucket] of stationBuckets) {
    const om = omMap.get(key);
    if (!om) continue;
    matched++;

    const month = parseInt(key.slice(5, 7), 10) - 1; // 0-indexed
    const hour = parseInt(key.slice(11, 13), 10);

    const stationAvg = {
      temp: mean(bucket.temp),
      humidity: mean(bucket.humidity),
      wind_speed: mean(bucket.wind_speed),
      solar_radiation: mean(bucket.solar_radiation),
    };

    biasArrays.temperature[month][hour].push(stationAvg.temp - om.temp);
    biasArrays.humidity[month][hour].push(stationAvg.humidity - om.humidity);
    biasArrays.wind_speed[month][hour].push(stationAvg.wind_speed - om.wind_speed);
    biasArrays.solar_radiation[month][hour].push(stationAvg.solar_radiation - om.solar_radiation);
  }
  console.log(`  ${matched} matched hourly pairs for bias computation`);

  // Average the bias arrays into final values (null where no data)
  const biasTable: Record<MetricName, (number | null)[][]> = {
    temperature: Array.from({ length: 12 }, () => Array(24).fill(null)),
    humidity: Array.from({ length: 12 }, () => Array(24).fill(null)),
    wind_speed: Array.from({ length: 12 }, () => Array(24).fill(null)),
    solar_radiation: Array.from({ length: 12 }, () => Array(24).fill(null)),
  };

  for (const metric of metrics) {
    for (let m = 0; m < 12; m++) {
      for (let h = 0; h < 24; h++) {
        const arr = biasArrays[metric][m][h];
        if (arr.length > 0) {
          biasTable[metric][m][h] = Math.round(mean(arr) * 100) / 100;
        }
      }
    }
  }

  // Fill null cells by copying nearest available month's bias
  for (const metric of metrics) {
    for (let m = 0; m < 12; m++) {
      for (let h = 0; h < 24; h++) {
        if (biasTable[metric][m][h] != null) continue;
        // Search outward from this month
        for (let d = 1; d <= 6; d++) {
          const prev = ((m - d) % 12 + 12) % 12;
          const next = (m + d) % 12;
          if (biasTable[metric][prev][h] != null) {
            biasTable[metric][m][h] = biasTable[metric][prev][h];
            break;
          }
          if (biasTable[metric][next][h] != null) {
            biasTable[metric][m][h] = biasTable[metric][next][h];
            break;
          }
        }
      }
    }
  }

  // Count filled cells
  let filled = 0, total = 0;
  for (const metric of metrics) {
    for (let m = 0; m < 12; m++) {
      for (let h = 0; h < 24; h++) {
        total++;
        if (biasTable[metric][m][h] != null) filled++;
      }
    }
  }
  console.log(`  ${filled}/${total} bias cells populated`);

  const output = {
    calibration_period: `${startDate} to ${endDate}`,
    generated_at: new Date().toISOString(),
    metrics: biasTable,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nBias table written to ${OUTPUT_PATH}`);
  console.log(`  File size: ${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error("Calibration failed:", err);
  process.exit(1);
});
