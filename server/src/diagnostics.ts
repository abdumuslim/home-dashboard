import type { Router, Request, Response } from "express";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { childLogger } from "./logger.js";
import type { Ct02Feed } from "./ct02-feed.js";
import { DIAG_PAGE_HTML } from "./diag-page.js";

const log = childLogger("diag");

/**
 * Sensor diagnostics — a read-only view of every live feed in the system.
 *
 * Built (2026-08-23) to watch the flashed CT02's two CT ports during the
 * port-B hardware fault hunt (docs/CT02_FLASH_PLAN.md → F4), then widened to
 * every sensor so there is one place that answers "is this feed actually
 * alive, and what exactly is it saying?".
 *
 * Strictly observational: it reads in-memory state and the newest row of each
 * table. It writes nothing, commands nothing, and — like tuya-power.ts — never
 * touches `latestPower`, the ESP ingest path, or the AC leveller.
 */

export interface DiagnosticsDeps {
  pool: pg.Pool;
  ct02: Ct02Feed | null;
  getLatestAir?: () => Record<string, unknown> | null;
  getLatestPower?: () => Record<string, unknown> | null;
  getLoopAgeMs?: () => number;
}

/** Row counts are cached — the page polls every couple of seconds and COUNT(*) is not free. */
const COUNT_CACHE_MS = 60_000;

/** Default history points returned to the page; the feed retains far more. */
const DEFAULT_HISTORY_POINTS = 240;
const MAX_HISTORY_POINTS = 1800;

function ageSeconds(ts: unknown, now: number): number | null {
  if (ts == null) return null;
  const ms = ts instanceof Date ? ts.getTime() : new Date(String(ts)).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.round((now - ms) / 1000);
}

/** Dates → ISO strings so the JSON is stable regardless of driver row typing. */
function normalizeRow(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    out[key] = val instanceof Date ? val.toISOString() : val;
  }
  return out;
}

export function registerDiagnosticsRoutes(router: Router, deps: DiagnosticsDeps): void {
  const { pool, ct02 } = deps;

  let countCache: { at: number; value: Record<string, number | null> } | null = null;

  async function tableCounts(now: number): Promise<Record<string, number | null>> {
    if (countCache && now - countCache.at < COUNT_CACHE_MS) return countCache.value;

    const tables = ["weather_readings", "air_readings", "power_readings", "tuya_power_readings"];
    const value: Record<string, number | null> = {};
    await Promise.all(tables.map(async (table) => {
      try {
        // Table names are from this fixed literal list, never from user input.
        const result = await pool.query(`SELECT COUNT(*)::bigint AS n FROM ${table}`);
        const n = result.rows[0]?.n;
        // A driver that answers with no row is reported as "unknown", not as 0 —
        // a fabricated zero would read as "this table is empty".
        value[table] = n === undefined ? null : Number(n);
      } catch (err) {
        // A missing table must not take the whole diagnostics page down —
        // "unknown" for one feed is far more useful than a 500 for all of them.
        log.warn(`[diag] count failed for ${table}: ${(err as Error).message}`);
        value[table] = null;
      }
    }));

    countCache = { at: now, value };
    return value;
  }

  async function latestRow(table: string): Promise<Record<string, unknown> | null> {
    try {
      const result = await pool.query(`SELECT * FROM ${table} ORDER BY ts DESC LIMIT 1`);
      return normalizeRow(result.rows[0]);
    } catch (err) {
      log.warn(`[diag] latest row failed for ${table}: ${(err as Error).message}`);
      return null;
    }
  }

  router.get("/api/diag", requireAuth, async (req: Request, res: Response) => {
    const now = Date.now();

    const requested = Number(req.query.history);
    const historyPoints = Number.isFinite(requested) && requested >= 0
      ? Math.min(Math.floor(requested), MAX_HISTORY_POINTS)
      : DEFAULT_HISTORY_POINTS;

    const [weatherRow, airRow, powerRow, tuyaRow, counts] = await Promise.all([
      latestRow("weather_readings"),
      latestRow("air_readings"),
      latestRow("power_readings"),
      latestRow("tuya_power_readings"),
      tableCounts(now),
    ]);

    const liveAir = deps.getLatestAir?.() ?? null;
    const livePower = deps.getLatestPower?.() ?? null;

    const ct02Snapshot = ct02
      ? (() => {
          const snap = ct02.snapshot();
          // slice(-0) is slice(0) — it returns the WHOLE ring rather than
          // nothing, so history=0 must be handled explicitly.
          const history = historyPoints === 0 ? [] : snap.history.slice(-historyPoints);
          return { ...snap, history };
        })()
      : null;

    res.json({
      now,
      collectorLoopAgeMs: deps.getLoopAgeMs?.() ?? null,
      ct02: ct02Snapshot,
      esp: {
        live: livePower,
        liveAgeSeconds: ageSeconds((livePower as { ts?: unknown } | null)?.ts, now),
        lastStored: powerRow,
        lastStoredAgeSeconds: ageSeconds(powerRow?.ts, now),
      },
      air: {
        live: liveAir,
        liveAgeSeconds: ageSeconds((liveAir as { ts?: unknown } | null)?.ts, now),
        lastStored: airRow,
        lastStoredAgeSeconds: ageSeconds(airRow?.ts, now),
      },
      weather: {
        lastStored: weatherRow,
        lastStoredAgeSeconds: ageSeconds(weatherRow?.ts, now),
      },
      tuya: {
        lastStored: tuyaRow,
        lastStoredAgeSeconds: ageSeconds(tuyaRow?.ts, now),
      },
      counts,
    });
  });

  // The page shell itself. Registered on this router so it resolves before the
  // SPA catch-all in index.ts, which would otherwise serve the React app here.
  router.get("/diag", (_req: Request, res: Response) => {
    // The app's no-cache middleware only covers /api/ and .js/.css/.html paths,
    // so this extensionless route would otherwise carry no Cache-Control at all
    // and a browser could heuristically serve a stale shell after a redeploy.
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.type("html").send(DIAG_PAGE_HTML);
  });
}
