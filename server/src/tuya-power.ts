import { timingSafeEqual } from "crypto";
import type { Router, Request, Response } from "express";
import type pg from "pg";
import type { Config } from "./config.js";
import { requireAuth } from "./auth.js";

/**
 * Tuya SHADOW power feed (ZheerHome QS-WIFI-CT02, the ESP-replacement's P2).
 *
 * This feed is deliberately ISOLATED from the ESP path in routes.ts: it NEVER
 * calls onPowerIngest, NEVER touches latestPower / powerBuffer, and writes ONLY
 * tuya_power_readings. The leveling controller's ESP-gap strain detection and
 * flicker statistics key off the single ESP stream — a second interleaved feed
 * corrupts them — so nothing here may reach the leveler or the ESP GET state.
 */

/** Same shape as latestPower in routes.ts. */
export interface TuyaPowerReading {
  ts: string;
  voltage: number;
  current_1: number;
  current_2: number;
  power_1: number;
  power_2: number;
}

// Duplicated (not imported from routes.ts) to keep the dependency one-directional
// and the ESP route's semantics untouched — same pure logic as routes.median().
function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Timing-safe Bearer-token check (mirrors auth.ts safeCompare). */
function bearerMatches(header: string | string[] | undefined, expected: string): boolean {
  if (Array.isArray(header)) return false;
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Registers the Tuya shadow power routes on `router`. All state is closure-local
 * to this call (one router == one server), exactly like latestPower in routes.ts.
 * Must be registered AFTER the auth middleware so requireAuth works on the GET.
 */
export function registerTuyaPowerRoutes(router: Router, pool: pg.Pool, config?: Config): void {
  // In-memory latest Tuya reading (updated every ingest), saved to DB every 60s.
  let latestTuyaPower: TuyaPowerReading | null = null;
  let ingestCount = 0;
  let lastTuyaSave = 0;
  const TUYA_SAVE_INTERVAL = 60_000;
  const tuyaBuffer: { v: number; i1: number; i2: number }[] = [];

  // ---------- Tuya SHADOW power ingest (isolated from the ESP path) ----------
  router.post("/api/power/tuya-ingest", async (req: Request, res: Response) => {
    const token = config?.tuyaIngestToken ?? "";
    if (!token) {
      // Fail closed: no token configured means the shadow feed is disabled.
      res.status(503).json({ error: "tuya ingest disabled" });
      return;
    }
    if (!bearerMatches(req.headers.authorization, token)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { v, i1, i2 } = req.body as { v: number; i1: number; i2: number };
    if (typeof v !== "number" || typeof i1 !== "number" || typeof i2 !== "number") {
      res.status(400).json({ error: "Missing or invalid fields: v, i1, i2 (all required, numeric)" });
      return;
    }
    if (!isFinite(v) || !isFinite(i1) || !isFinite(i2)) {
      res.status(400).json({ error: "Values must be finite numbers" });
      return;
    }

    const p1 = v * i1;
    const p2 = v * i2;
    const now = new Date();
    latestTuyaPower = { ts: now.toISOString(), voltage: v, current_1: i1, current_2: i2, power_1: p1, power_2: p2 };
    ingestCount++;
    tuyaBuffer.push({ v, i1, i2 });

    // Persist median of buffered readings to the SHADOW table every 60 seconds.
    if (now.getTime() - lastTuyaSave >= TUYA_SAVE_INTERVAL && tuyaBuffer.length > 0) {
      lastTuyaSave = now.getTime();
      const medV = median(tuyaBuffer.map(r => r.v));
      const medI1 = median(tuyaBuffer.map(r => r.i1));
      const medI2 = median(tuyaBuffer.map(r => r.i2));
      const medP1 = medV * medI1;
      const medP2 = medV * medI2;
      tuyaBuffer.length = 0;
      await pool.query(
        `INSERT INTO tuya_power_readings (ts, voltage, current_1, current_2, power_1, power_2)
         VALUES (NOW(), $1, $2, $3, $4, $5)
         ON CONFLICT (ts) DO NOTHING`,
        [medV, medI1, medI2, medP1, medP2],
      );
    }
    res.json({ ok: true });
  });

  // Shadow-feed observability: latest reading + staleness, behind auth like other GETs.
  router.get("/api/power/tuya", requireAuth, (_req: Request, res: Response) => {
    const staleSeconds = latestTuyaPower
      ? Math.round((Date.now() - new Date(latestTuyaPower.ts).getTime()) / 1000)
      : null;
    res.json({ latest: latestTuyaPower, staleSeconds, ingestCount });
  });
}
