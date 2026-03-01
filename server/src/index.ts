import { config } from "./config.js";
import { createPool, initDb } from "./database.js";
import { Collector } from "./collector.js";
import { createRouter } from "./routes.js";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    console.error("[index] Collector crashed:", err);
  });

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
  app.use(createRouter(pool, config));

  // Serve static files from ../static (relative to dist/ or src/)
  const staticDir = path.resolve(__dirname, "..", "static");
  app.use(express.static(staticDir));

  // SPA catch-all: serve index.html for any non-API route not matched by static
  app.get("/{*splat}", (_req: Request, res: Response) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });

  const PORT = 8000;
  app.listen(PORT, () => {
    console.log(`[index] Dashboard server running on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = (): void => {
    console.log("[index] Shutting down...");
    collector.stop();
    pool.end().then(() => {
      console.log("[index] Database pool closed");
      process.exit(0);
    }).catch((err) => {
      console.error("[index] Error closing pool:", err);
      process.exit(1);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[index] Fatal error:", err);
  process.exit(1);
});
