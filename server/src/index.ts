import { config } from "./config.js";
import { createPool, initDb } from "./database.js";
import { Collector } from "./collector.js";
import { ForecastService } from "./forecast.js";
import { createRouter } from "./routes.js";
import { childLogger } from "./logger.js";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const log = childLogger("index");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  // Create database pool and initialize schema
  const pool = await createPool(config.databaseUrl);
  await initDb(pool);

  // Start the collector in the background
  const collector = new Collector(pool, config);
  const collectorPromise = collector.runForever();
  collectorPromise.catch((err) => {
    log.error("[index] Collector crashed:", err);
  });

  // Start the forecast service
  const biasPath = path.resolve(__dirname, "..", "bias-data", "bias-table.json");
  const forecastService = new ForecastService(biasPath);
  forecastService.init();

  // Create Express app
  const app = express();

  // No-cache middleware for API and static asset responses
  app.use((req: Request, res: Response, next: NextFunction) => {
    const p = req.path;
    if (p.startsWith("/api/") || p.endsWith(".js") || p.endsWith(".css") || p.endsWith(".html")) {
      res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    }
    next();
  });

  // Parse JSON bodies for push subscription endpoints
  app.use(express.json());

  // Mount API routes
  app.use(createRouter(
    pool,
    config,
    () => collector.xiaomiCloud,
    () => collector.tclCloud,
    () => collector.getLatestAir(),
    () => forecastService.getForecast(),
    (data) => collector.setLatestPower(data),
    () => collector.invalidateAutomationRules(),
    {
      record: (deviceId, reason) => collector.recordAcManualOff(deviceId, reason),
      clear: (deviceId) => collector.clearAcManualOff(deviceId),
      isLocked: (deviceId) => collector.isAcManualOffLocked(deviceId),
      getLockedIds: (deviceIds) => collector.getAcManualOffLockedIds(deviceIds),
      reconcileDevices: (devices) => collector.reconcileAcManualOffLocks(devices),
      onUserFanChange: (deviceId) => collector.noteUserAcFanChange(deviceId),
      onUserFanAuto: (deviceId) => collector.noteUserAcFanAuto(deviceId),
      onUserSwingChange: (deviceId) => collector.noteUserAcSwingChange(deviceId),
      onUserProfileChange: (deviceId, command) => collector.noteUserAcProfileChange(deviceId, command),
      onUserBeep: (deviceId, beepOn) => collector.noteUserAcBeep(deviceId, beepOn),
      notifyLockCleared: (deviceId, authKind, ip) => collector.notifyAcLockCleared(deviceId, authKind, ip),
    },
    {
      // Route through the ACTIVE controller (v1 unless the v2 flag says v2);
      // v2-specific handlers always hit the v2 instance.
      getConfig: async () => {
        const config = await collector.leveling().getConfig();
        return { ...(config as Record<string, unknown>), controller: collector.acLeveler2.controllerFlavor() };
      },
      updateConfig: (cfg) => collector.leveling().updateConfig(cfg as never),
      getStatus: () => collector.leveling().getStatus(),
      onUserPowerOff: (deviceId) => collector.leveling().onUserPowerOff(deviceId),
      onUserPowerOn: (deviceId) => collector.leveling().onUserPowerOn(deviceId),
      noteUserGenLevel: (deviceId) => collector.noteUserAcGenLevel(deviceId),
      onUserGenLevel: (deviceId, level) => collector.onUserAcGenLevel(deviceId, level),
      updateV2Config: (cfg) => collector.acLeveler2.updateConfig(cfg),
      getJournal: (hours) => collector.acLeveler2.recentJournal(hours),
      resetCosts: () => collector.acLeveler2.resetLearnedCosts(),
    },
    {
      start: (deviceIds, includeFan) => collector.acCalibrator.start(deviceIds, includeFan),
      abort: (reason) => collector.acCalibrator.abort(reason),
      getStatus: () => collector.acCalibrator.getStatus(),
      getResults: () => collector.acCalibrator.getResults(),
      requestAbort: (reason) => collector.acCalibrator.requestAbort(reason),
    },
    () => collector.getLoopAgeMs(),
  ));

  // Serve static files from ../static (relative to dist/ or src/)
  const staticDir = path.resolve(__dirname, "..", "static");
  app.use(express.static(staticDir));

  // SPA catch-all: serve index.html for any non-API route not matched by static
  app.get("/{*splat}", (_req: Request, res: Response) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });

  const PORT = 8000;
  app.listen(PORT, () => {
    log.info(`[index] Dashboard server running on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = (): void => {
    log.info("[index] Shutting down...");
    collector.stop();
    forecastService.stop();
    pool.end().then(() => {
      log.info("[index] Database pool closed");
      process.exit(0);
    }).catch((err) => {
      log.error("[index] Error closing pool:", err);
      process.exit(1);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("[index] Fatal error:", err);
  process.exit(1);
});
