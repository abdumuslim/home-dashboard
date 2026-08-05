// Stateful wrapper around the pure power-stats logic: pulls the raw minute
// stream from Postgres, assembles the card payload and the history breakdown,
// and caches each for 60s. Card stats also invalidate early when the live source
// flips, so a grid<->gen changeover is reflected at once.

import pg from "pg";
import { childLogger } from "./logger.js";
import { determineSource, type PowerSource } from "./ac-leveling.js";
import {
  toMinuteSources,
  smoothFlickers,
  buildSessions,
  resolveCurrentSession,
  gridMinutesInWindow,
  averageSessionHours,
  dayBreakdownForWindow,
  MINUTE_MS,
  DAY_MS,
  type PowerMinuteRow,
  type DayBreakdownEntry,
} from "./power-stats.js";
import { predictNextSwitch } from "./power-predict.js";

const log = childLogger("power-stats");

const STATS_LOOKBACK_DAYS = 15; // learning window for the slot/survival predictor
const CACHE_TTL_MS = 60_000;

export interface PowerStatsPayload {
  generatedAt: string;
  source: PowerSource;
  sessionStartTs: string | null;
  sessionMinutes: number;
  expectedRemainingMinutes: number | null;
  /** Events backing the prediction (switches, or survival samples) — name kept for payload stability. */
  predictionSampleDays: number;
  /** Which path produced the estimate; diagnostics only, the card does not show it. */
  predictionMethod: "slot" | "survival" | null;
  gridHours24h: number;
  avgGridSessionHours: number | null; // avg length of one grid stretch (time between switches), 7d
  avgGenSessionHours: number | null;
}

export interface DayBreakdownPayload {
  range: string;
  days: DayBreakdownEntry[];
  totals: { gridHours: number; genHours: number; offHours: number };
}

type LatestPower = { ts: string; current_1: number; current_2: number } | null;

interface MinuteRowResult {
  ts: Date;
  current_1: number;
  current_2: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export class PowerStatsService {
  private statsCache: { at: number; payload: PowerStatsPayload } | null = null;
  private breakdownCache = new Map<string, { at: number; payload: DayBreakdownPayload }>();

  constructor(
    private pool: pg.Pool,
    private getLatestPower: () => LatestPower,
  ) {}

  private liveSource(): PowerSource {
    const lp = this.getLatestPower();
    return determineSource(lp, lp ? Date.now() - Date.parse(lp.ts) : Infinity);
  }

  private async fetchMinuteRows(interval: string): Promise<PowerMinuteRow[]> {
    const result = await this.pool.query<MinuteRowResult>(
      `SELECT ts, current_1, current_2 FROM power_readings
       WHERE ts >= NOW() - INTERVAL '${interval}'
       ORDER BY ts ASC`,
    );
    return result.rows.map((r) => ({ ts: r.ts, current_1: r.current_1, current_2: r.current_2 }));
  }

  async getStats(): Promise<PowerStatsPayload> {
    const source = this.liveSource();
    const cached = this.statsCache;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS && cached.payload.source === source) {
      return cached.payload;
    }

    const rows = await this.fetchMinuteRows(`${STATS_LOOKBACK_DAYS} days`);

    const nowMs = Date.now();
    const startMs = Math.floor((nowMs - STATS_LOOKBACK_DAYS * DAY_MS) / MINUTE_MS) * MINUTE_MS;
    const series = smoothFlickers(toMinuteSources(rows, startMs, nowMs));
    const sessions = buildSessions(series, startMs);

    const cur = resolveCurrentSession(sessions, source, nowMs);
    const pred = predictNextSwitch({ sessions, nowMs, liveSource: source });
    const gridHours24h = round1(gridMinutesInWindow(series, startMs, nowMs - DAY_MS, nowMs) / 60);
    const { avgGridSessionHours, avgGenSessionHours } = averageSessionHours(sessions, nowMs - 7 * DAY_MS);

    const payload: PowerStatsPayload = {
      generatedAt: new Date(nowMs).toISOString(),
      source,
      sessionStartTs: new Date(cur.startMs).toISOString(),
      sessionMinutes: cur.minutes,
      expectedRemainingMinutes: pred?.remainingMinutes ?? null,
      predictionSampleDays: pred?.sampleCount ?? 0,
      predictionMethod: pred?.method ?? null,
      gridHours24h,
      avgGridSessionHours,
      avgGenSessionHours,
    };
    this.statsCache = { at: nowMs, payload };
    return payload;
  }

  async getDayBreakdown(rangeKey: string, interval: string): Promise<DayBreakdownPayload> {
    const cached = this.breakdownCache.get(rangeKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload;

    const rows = await this.fetchMinuteRows(interval);
    const nowMs = Date.now();
    const rangeMs = rangeIntervalToMs(interval, nowMs);
    const fromMs = nowMs - rangeMs;
    const startMs = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS;
    const series = smoothFlickers(toMinuteSources(rows, startMs, nowMs));
    const { days, totals } = dayBreakdownForWindow(series, startMs, fromMs, nowMs);

    const payload: DayBreakdownPayload = { range: rangeKey, days, totals };
    this.breakdownCache.set(rangeKey, { at: nowMs, payload });
    return payload;
  }

}

/** Convert a whitelisted RANGE_MAP interval string (e.g. "24 hours", "7 days") to ms. */
function rangeIntervalToMs(interval: string, _nowMs: number): number {
  const [nStr, unit] = interval.split(" ");
  const n = parseInt(nStr, 10);
  if (unit.startsWith("hour")) return n * 60 * MINUTE_MS;
  if (unit.startsWith("day")) return n * DAY_MS;
  log.warn(`Unknown interval unit "${interval}", defaulting to 24h`);
  return DAY_MS;
}
