import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createRouter } from "./routes.js";
import { registerDiagnosticsRoutes } from "./diagnostics.js";
import { Ct02Feed } from "./ct02-feed.js";
import { signToken } from "./auth.js";
import type { Config } from "./config.js";

const TEST_CONFIG: Config = {
  qpAppKey: "", qpAppSecret: "", awApiKey: "", awAppKey: "", databaseUrl: "",
  vapidPublicKey: "", vapidPrivateKey: "", vapidSubject: "",
  mqttBrokerUrl: "", mqttUsername: "", mqttPassword: "", mqttQingpingMac: "",
  miEmail: "", miPassword: "", miRegion: "sg",
  tclUsername: "", tclPassword: "",
  authSecret: "auth-secret", adminUser: "admin", adminPassword: "password",
  hermesApiToken: "",
  tuyaIngestToken: "",
  ct02TopicBase: "ln882hC25E1088",
  observedOffLocks: true,
};

function createRecordingPool() {
  const queries: string[] = [];
  return {
    queries,
    writes: () => queries.filter(q => /INSERT|UPDATE|DELETE/i.test(q)),
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  };
}

/**
 * Mounts the app exactly as index.ts does: the API router first (its auth
 * middleware runs there), then the diagnostics router. That ordering is a
 * NON-LOCAL dependency — /api/diag's auth lives in a different file — so it is
 * pinned here rather than assumed.
 */
let testClock = 1_000_000;
function advanceClock(ms: number): void { testClock += ms; }

async function startServer(options: { ingested?: unknown[] } = {}) {
  testClock = 1_000_000;
  const pool = createRecordingPool();
  const feed = new Ct02Feed({
    brokerUrl: "mqtt://test:1883", username: "u", password: "p",
    topicBase: "ln882hC25E1088", now: () => testClock,
  });

  const app = express();
  app.use(express.json());
  app.use(createRouter(
    pool as never,
    TEST_CONFIG,
    undefined,
    undefined,
    undefined,
    undefined,
    (data) => options.ingested?.push(data),
  ));

  const diagRouter = express.Router();
  registerDiagnosticsRoutes(diagRouter, {
    pool: pool as never,
    ct02: feed,
    getLatestAir: () => null,
    getLatestPower: () => null,
  });
  app.use(diagRouter);

  // The real app mounts express.static + an SPA catch-all after this point.
  // Without a catch-all here the "/diag resolves first" test proves nothing,
  // so the catch-all is mounted with a distinguishable body.
  app.get("/{*splat}", (_req, res) => { res.type("html").send("<html>SPA CATCH-ALL</html>"); });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  return { url: `http://127.0.0.1:${address.port}`, pool, feed };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()));
  })));
});

function loginCookie(): string {
  return `auth=${signToken({ user: "admin", exp: Date.now() + 60_000 }, TEST_CONFIG.authSecret)}`;
}

describe("GET /api/diag — auth", () => {
  it("fails CLOSED with 401 when unauthenticated", async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}/api/diag`);
    expect(res.status).toBe(401);
  });

  it("serves the aggregate once authenticated — proving auth reaches the later-mounted router", async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}/api/diag`, { headers: { Cookie: loginCookie() } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("ct02");
    expect(body).toHaveProperty("esp");
    expect(body).toHaveProperty("air");
    expect(body).toHaveProperty("weather");
    expect(body).toHaveProperty("tuya");
    expect(body.ct02.connection.topicBase).toBe("ln882hC25E1088");
  });
});

describe("GET /diag — page shell", () => {
  it("serves the page ahead of the SPA catch-all", async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}/diag`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/html/);
    // Extensionless route — the app's no-cache middleware does not cover it, so
    // the route sets its own header or a redeploy can be masked by a stale shell.
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const body = await res.text();
    expect(body).toContain("Sensor Diagnostics");
    expect(body).not.toContain("SPA CATCH-ALL");
  });
});

describe("diagnostics isolation", () => {
  it("never writes to the database and never reaches the ESP ingest path", async () => {
    const ingested: unknown[] = [];
    const { url, pool } = await startServer({ ingested });

    await fetch(`${url}/api/diag`, { headers: { Cookie: loginCookie() } });

    expect(pool.writes()).toEqual([]);
    expect(ingested).toEqual([]);
    // Only newest-row reads and the cached counts.
    expect(pool.queries.every(q => /^SELECT/i.test(q.trim()))).toBe(true);
  });

  it("caps the history it serializes so a 2 s poll cannot ship the whole ring buffer", async () => {
    const { url, feed } = await startServer();
    // The clock MUST advance: the feed throttles history to one sample per
    // second, so a burst at a frozen clock yields a single sample and the cap
    // assertion would pass even with the slicing removed.
    for (let i = 0; i < 400; i++) {
      advanceClock(1000);
      feed.handleMessage("ln882hC25E1088/3/get", String(i));
    }
    expect(feed.snapshot().history.length).toBeGreaterThan(50);

    const res = await fetch(`${url}/api/diag?history=10`, { headers: { Cookie: loginCookie() } });
    const body = await res.json();
    expect(body.ct02.history.length).toBe(10);
  });

  it("returns no history at all for history=0 (slice(-0) would return everything)", async () => {
    const { url, feed } = await startServer();
    for (let i = 0; i < 5; i++) {
      advanceClock(1000);
      feed.handleMessage("ln882hC25E1088/3/get", String(i));
    }

    const res = await fetch(`${url}/api/diag?history=0`, { headers: { Cookie: loginCookie() } });
    const body = await res.json();
    expect(body.ct02.history).toEqual([]);
  });
});
