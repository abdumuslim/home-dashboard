// Pure power-source session/stats logic — no I/O, no Date.now(), fully unit-testable.
// Everything downstream (24h grid hours, daily averages, session duration,
// time-remaining prediction, per-day history breakdown) is DERIVED from the
// power_readings minute stream. There is no stored source/session/event table;
// a minute is classified grid/gen/none by the same rule the AC leveler and the
// power card use (determineSource). Missing minutes = blackout ("none").
//
// The stateful wrapper (power-stats-service.ts) supplies the DB rows and "now".

import { determineSource, type PowerSource } from "./ac-leveling.js";

export const BAGHDAD_UTC_OFFSET_MS = 3 * 3_600_000; // Iraq: permanent UTC+3, no DST
export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
export const FLICKER_MAX_MINUTES = 2;
export const PREDICTION_LOOKBACK_DAYS = 14;
export const PREDICTION_MIN_SAMPLES = 2;
export const PREDICTION_MAX_MINUTES = 24 * 60;
export const TEMP_KERNEL_SIGMA_C = 4;
export const MISSING_TEMP_WEIGHT = 0.25;

export interface PowerMinuteRow {
  ts: Date;
  current_1: number;
  current_2: number;
}

export interface Session {
  source: PowerSource;
  startMs: number;
  endMs: number; // exclusive
  minutes: number;
}

export interface DayBreakdownEntry {
  date: string;
  gridHours: number;
  genHours: number;
  offHours: number;
  partial: boolean;
}

export interface PredictionResult {
  remainingMinutes: number;
  sampleDays: number;
}

/** The one and only classification path — mirrors the power card / leveler. */
export function classifyRow(row: { current_1: number; current_2: number }): PowerSource {
  // staleMs 0: the row exists, so it is never "stale" here.
  return determineSource(row, 0);
}

/**
 * Materialize a dense per-minute source array. Index `i` covers the minute
 * [startMs + i*MINUTE_MS, +60s). `startMs` must already be floored to a minute.
 * Each row's ts is floored to its minute; duplicates in a minute → last wins;
 * minutes with no row → "none" (this is where a blackout / ESP silence appears).
 */
export function toMinuteSources(rows: PowerMinuteRow[], startMs: number, endMs: number): PowerSource[] {
  const count = Math.max(0, Math.floor((endMs - startMs) / MINUTE_MS));
  const series: PowerSource[] = new Array(count).fill("none");
  for (const row of rows) {
    const minuteMs = Math.floor(row.ts.getTime() / MINUTE_MS) * MINUTE_MS;
    const idx = Math.floor((minuteMs - startMs) / MINUTE_MS);
    if (idx < 0 || idx >= count) continue;
    series[idx] = classifyRow(row); // last row in a minute wins (rows are ascending)
  }
  return series;
}

/**
 * Heal short flickers: any run of length <= maxFlicker whose BOTH neighbors
 * share a source becomes that source (absorbs 1-2 min ESP wifi dropouts and
 * switch blips). Runs at the array edges, or between two DIFFERENT neighbors
 * (a genuine grid|none|gen changeover), are kept. Returns a new array.
 */
export function smoothFlickers(series: PowerSource[], maxFlicker = FLICKER_MAX_MINUTES): PowerSource[] {
  const out = series.slice();
  let i = 0;
  while (i < out.length) {
    let j = i;
    while (j < out.length && out[j] === out[i]) j++;
    const runLen = j - i;
    const hasLeft = i > 0;
    const hasRight = j < out.length;
    if (runLen <= maxFlicker && hasLeft && hasRight && out[i - 1] === out[j]) {
      const fill = out[i - 1];
      for (let k = i; k < j; k++) out[k] = fill;
    }
    i = j;
  }
  return out;
}

/** Collapse consecutive equal minutes into sessions (including "none"). */
export function buildSessions(series: PowerSource[], seriesStartMs: number): Session[] {
  const sessions: Session[] = [];
  let i = 0;
  while (i < series.length) {
    let j = i;
    while (j < series.length && series[j] === series[i]) j++;
    const startMs = seriesStartMs + i * MINUTE_MS;
    const endMs = seriesStartMs + j * MINUTE_MS;
    sessions.push({ source: series[i], startMs, endMs, minutes: (endMs - startMs) / MINUTE_MS });
    i = j;
  }
  return sessions;
}

/**
 * Resolve the currently-running session from the reconstructed sessions and the
 * live source. Handles the three states: persisted-tail-matches-live, a fresh
 * grid<->gen switch not yet in the minute data, and a blackout that began when
 * the rows stopped.
 */
export function resolveCurrentSession(
  sessions: Session[],
  liveSource: PowerSource,
  nowMs: number,
): { source: PowerSource; startMs: number; minutes: number } {
  if (sessions.length === 0) return { source: liveSource, startMs: nowMs, minutes: 0 };
  const tail = sessions[sessions.length - 1];
  if (tail.source === liveSource) {
    return { source: liveSource, startMs: tail.startMs, minutes: Math.round((nowMs - tail.startMs) / MINUTE_MS) };
  }
  if (liveSource === "none") {
    // Blackout began when the rows stopped (tail's data edge).
    return { source: "none", startMs: tail.endMs, minutes: Math.round((nowMs - tail.endMs) / MINUTE_MS) };
  }
  // Fresh grid<->gen switch the minute writer hasn't persisted yet.
  return { source: liveSource, startMs: nowMs, minutes: 0 };
}

/** Count "grid" minutes whose start falls in [fromMs, toMs), clamped to series bounds. */
export function gridMinutesInWindow(
  series: PowerSource[],
  seriesStartMs: number,
  fromMs: number,
  toMs: number,
): number {
  const startIdx = Math.max(0, Math.ceil((fromMs - seriesStartMs) / MINUTE_MS));
  const endIdx = Math.min(series.length, Math.ceil((toMs - seriesStartMs) / MINUTE_MS));
  let count = 0;
  for (let i = startIdx; i < endIdx; i++) if (series[i] === "grid") count++;
  return count;
}

export function baghdadDateKey(ms: number): string {
  return new Date(ms + BAGHDAD_UTC_OFFSET_MS).toISOString().slice(0, 10); // YYYY-MM-DD
}

export function baghdadHourKey(ms: number): string {
  return new Date(ms + BAGHDAD_UTC_OFFSET_MS).toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

/**
 * Average duration of a single grid/gen stretch — the typical "time between
 * switches" — over sessions that ended within [windowStartMs, now). The final
 * session is excluded (still running → its length is censored); "none"/blackout
 * sessions are ignored (we only average powered stretches). Hours, 1 decimal;
 * no completed session for a source → null.
 */
export function averageSessionHours(
  sessions: Session[],
  windowStartMs: number,
): { avgGridSessionHours: number | null; avgGenSessionHours: number | null } {
  const gridMins: number[] = [];
  const genMins: number[] = [];
  for (let i = 0; i < sessions.length - 1; i++) {
    const s = sessions[i];
    if (s.endMs < windowStartMs) continue; // the switch happened before the window
    if (s.source === "grid") gridMins.push(s.minutes);
    else if (s.source === "gen") genMins.push(s.minutes);
  }
  const avg = (arr: number[]): number | null =>
    arr.length === 0 ? null : Math.round((arr.reduce((a, b) => a + b, 0) / arr.length / 60) * 10) / 10;
  return { avgGridSessionHours: avg(gridMins), avgGenSessionHours: avg(genMins) };
}

/** Weighted median: first value whose cumulative weight reaches half the total. */
export function weightedMedian(samples: { value: number; weight: number }[]): number {
  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  let cum = 0;
  for (const s of sorted) {
    cum += s.weight;
    if (cum >= total / 2) return s.value;
  }
  return sorted[sorted.length - 1].value;
}

/**
 * Predict how many more minutes the current source will last, learning from the
 * previous `lookbackDays` days at the same Baghdad wall-clock time, weighted by
 * outdoor-temperature similarity (Gaussian kernel). Returns null when there is
 * not enough usable history (client hides the estimate).
 */
export function predictRemainingMinutes(args: {
  sessions: Session[];
  nowMs: number;
  liveSource: PowerSource;
  hourlyTempByKey: Map<string, number>;
  nowTempC: number | null;
  lookbackDays?: number;
}): PredictionResult | null {
  const { sessions, nowMs, liveSource, hourlyTempByKey, nowTempC } = args;
  const lookbackDays = args.lookbackDays ?? PREDICTION_LOOKBACK_DAYS;
  const lastSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  const samples: { value: number; weight: number }[] = [];

  for (let d = 1; d <= lookbackDays; d++) {
    const sampleMs = nowMs - d * DAY_MS; // exact 24h steps preserve Baghdad wall-clock
    const s = sessions.find((x) => x.startMs <= sampleMs && sampleMs < x.endMs);
    if (!s) continue;
    if (s.source !== liveSource) continue;
    // Censoring: the final session's endMs is the data edge, not a real ending.
    // Only the last session can be right-censored, so this identity check is complete.
    if (s === lastSession) continue;

    const value = (s.endMs - sampleMs) / MINUTE_MS;
    let weight = 1;
    if (nowTempC != null) {
      const histTemp = hourlyTempByKey.get(baghdadHourKey(sampleMs));
      if (histTemp == null) weight = MISSING_TEMP_WEIGHT;
      else weight = Math.exp(-(((histTemp - nowTempC) / TEMP_KERNEL_SIGMA_C) ** 2));
    }
    samples.push({ value, weight });
  }

  if (samples.length < PREDICTION_MIN_SAMPLES) return null;
  const remainingMinutes = Math.min(PREDICTION_MAX_MINUTES, Math.max(0, Math.round(weightedMedian(samples))));
  return { remainingMinutes, sampleDays: samples.length };
}

/**
 * Per-Baghdad-day grid/gen/off hours within [fromMs, toMs), plus range totals.
 * offHours = covered minutes minus grid minus gen (= the "none" count), so
 * partial days still sum to their covered hours. Days ascending.
 */
export function dayBreakdownForWindow(
  series: PowerSource[],
  seriesStartMs: number,
  fromMs: number,
  toMs: number,
): { days: DayBreakdownEntry[]; totals: { gridHours: number; genHours: number; offHours: number } } {
  const startIdx = Math.max(0, Math.ceil((fromMs - seriesStartMs) / MINUTE_MS));
  const endIdx = Math.min(series.length, Math.ceil((toMs - seriesStartMs) / MINUTE_MS));

  const byDay = new Map<string, { grid: number; gen: number; covered: number }>();
  const order: string[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const key = baghdadDateKey(seriesStartMs + i * MINUTE_MS);
    let day = byDay.get(key);
    if (!day) {
      day = { grid: 0, gen: 0, covered: 0 };
      byDay.set(key, day);
      order.push(key);
    }
    day.covered++;
    if (series[i] === "grid") day.grid++;
    else if (series[i] === "gen") day.gen++;
  }

  const round2 = (x: number) => Math.round(x * 100) / 100;
  const days: DayBreakdownEntry[] = order.map((key) => {
    const d = byDay.get(key)!;
    return {
      date: key,
      gridHours: round2(d.grid / 60),
      genHours: round2(d.gen / 60),
      offHours: round2((d.covered - d.grid - d.gen) / 60),
      partial: d.covered < 1440,
    };
  });
  const totals = {
    gridHours: round2(days.reduce((s, d) => s + d.gridHours, 0)),
    genHours: round2(days.reduce((s, d) => s + d.genHours, 0)),
    offHours: round2(days.reduce((s, d) => s + d.offHours, 0)),
  };
  return { days, totals };
}
