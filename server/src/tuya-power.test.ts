import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createRouter } from "./routes.js";
import { signToken } from "./auth.js";
import type { Config } from "./config.js";
import type { TuyaPowerReading } from "./tuya-power.js";

const TEST_CONFIG: Config = {
  qpAppKey: "", qpAppSecret: "", awApiKey: "", awAppKey: "", databaseUrl: "",
  vapidPublicKey: "", vapidPrivateKey: "", vapidSubject: "",
  mqttBrokerUrl: "", mqttUsername: "", mqttPassword: "", mqttQingpingMac: "",
  miEmail: "", miPassword: "", miRegion: "sg",
  tclUsername: "", tclPassword: "",
  authSecret: "auth-secret", adminUser: "admin", adminPassword: "password",
  hermesApiToken: "",
  tuyaIngestToken: "tuya-secret",
  observedOffLocks: true,
};

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/** Fake pool that logs every query so tests can assert on the persistence path. */
function createRecordingPool() {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    tuyaInserts: () => queries.filter((q) => q.sql.includes("INSERT INTO tuya_power_readings")),
    espInserts: () => queries.filter((q) => q.sql.includes("INSERT INTO power_readings")),
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
}

type IngestData = Parameters<NonNullable<Parameters<typeof createRouter>[6]>>[0];

async function startServer(options: {
  pool?: ReturnType<typeof createRecordingPool>;
  config?: Config;
  onPowerIngest?: (data: IngestData) => void;
} = {}) {
  const app = express();
  app.use(express.json());
  app.use(createRouter(
    (options.pool ?? createRecordingPool()) as never,
    options.config ?? TEST_CONFIG,
    undefined,
    undefined,
    undefined,
    undefined,
    options.onPowerIngest,
  ));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  })));
});

/** Locally minted cookie — same trick as ac-control-audit.test.ts (avoids the login rate limiter). */
function loginCookie(): string {
  return `auth=${signToken({ user: "admin", exp: Date.now() + 60_000 }, TEST_CONFIG.authSecret)}`;
}

function tuyaIngest(url: string, body: unknown, headers: Record<string, string> = { Authorization: "Bearer tuya-secret" }) {
  return fetch(`${url}/api/power/tuya-ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/power/tuya-ingest — auth + validation", () => {
  it("fails closed with 503 when TUYA_INGEST_TOKEN is unconfigured", async () => {
    const { server, url } = await startServer({ config: { ...TEST_CONFIG, tuyaIngestToken: "" } });
    servers.push(server);

    const resp = await tuyaIngest(url, { v: 220, i1: 5, i2: 1 });
    expect(resp.status).toBe(503);
    await expect(resp.json()).resolves.toEqual({ error: "tuya ingest disabled" });
  });

  it("rejects a wrong or missing bearer token with 401", async () => {
    const { server, url } = await startServer();
    servers.push(server);

    const wrong = await tuyaIngest(url, { v: 220, i1: 5, i2: 1 }, { Authorization: "Bearer nope" });
    expect(wrong.status).toBe(401);

    const missing = await tuyaIngest(url, { v: 220, i1: 5, i2: 1 }, {});
    expect(missing.status).toBe(401);
  });

  it("rejects a non-numeric or non-finite body with 400", async () => {
    const { server, url } = await startServer();
    servers.push(server);

    const nonNumeric = await tuyaIngest(url, { v: "220", i1: 5, i2: 1 });
    expect(nonNumeric.status).toBe(400);

    const nonFinite = await tuyaIngest(url, { v: 220, i1: Infinity, i2: 1 });
    expect(nonFinite.status).toBe(400);
  });

  it("accepts a valid reading and surfaces it on GET /api/power/tuya", async () => {
    const { server, url } = await startServer();
    servers.push(server);

    const post = await tuyaIngest(url, { v: 220, i1: 5, i2: 1 });
    expect(post.status).toBe(200);
    await expect(post.json()).resolves.toEqual({ ok: true });

    const get = await fetch(`${url}/api/power/tuya`, { headers: { Cookie: loginCookie() } });
    expect(get.status).toBe(200);
    const body = await get.json() as { latest: TuyaPowerReading | null; staleSeconds: number | null; ingestCount: number };
    expect(body.latest?.voltage).toBe(220);
    expect(body.latest?.current_1).toBe(5);
    expect(body.latest?.current_2).toBe(1);
    expect(body.latest?.power_1).toBe(1100);
    expect(body.latest?.power_2).toBe(220);
    expect(body.ingestCount).toBe(1);
    expect(typeof body.staleSeconds).toBe("number");
  });
});

describe("GET /api/power/tuya", () => {
  it("requires auth (401 without a session cookie)", async () => {
    const { server, url } = await startServer();
    servers.push(server);

    const resp = await fetch(`${url}/api/power/tuya`);
    expect(resp.status).toBe(401);
  });

  it("reports latest null before any ingest", async () => {
    const { server, url } = await startServer();
    servers.push(server);

    const resp = await fetch(`${url}/api/power/tuya`, { headers: { Cookie: loginCookie() } });
    await expect(resp.json()).resolves.toEqual({ latest: null, staleSeconds: null, ingestCount: 0 });
  });
});

describe("tuya_power_readings median persistence", () => {
  it("buffers within the 60s window and INSERTs once the window elapses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = new Date("2026-08-18T00:00:00.000Z").getTime();
    vi.setSystemTime(base);

    const pool = createRecordingPool();
    const { server, url } = await startServer({ pool });
    servers.push(server);

    // First reading: lastTuyaSave starts at 0, so it flushes immediately (mirrors the ESP path).
    await tuyaIngest(url, { v: 220, i1: 10, i2: 10 });
    expect(pool.tuyaInserts()).toHaveLength(1);

    // +30s: still inside the window → buffered, no new INSERT.
    vi.setSystemTime(base + 30_000);
    await tuyaIngest(url, { v: 220, i1: 5, i2: 1 });
    expect(pool.tuyaInserts()).toHaveLength(1);

    // +61s: window elapsed → INSERT the median of the two buffered readings.
    vi.setSystemTime(base + 61_000);
    await tuyaIngest(url, { v: 220, i1: 7, i2: 3 });
    const inserts = pool.tuyaInserts();
    expect(inserts).toHaveLength(2);
    // median(i1)=6, median(i2)=2, power = 220*6, 220*2.
    expect(inserts[1].params).toEqual([220, 6, 2, 1320, 440]);
    // The shadow feed never writes the ESP table.
    expect(pool.espInserts()).toHaveLength(0);
  });
});

describe("SHADOW feed isolation (must never reach the leveler or ESP state)", () => {
  it("a tuya-ingest POST does not invoke onPowerIngest and leaves latestPower untouched", async () => {
    const ingestCalls: IngestData[] = [];
    const { server, url } = await startServer({ onPowerIngest: (data) => { ingestCalls.push(data); } });
    servers.push(server);

    const post = await tuyaIngest(url, { v: 220, i1: 8, i2: 2 });
    expect(post.status).toBe(200);

    // The leveling callback must NOT have fired for the shadow feed.
    expect(ingestCalls).toHaveLength(0);

    // The ESP GET state (latestPower) must be untouched — still null.
    const espState = await fetch(`${url}/api/current/power`);
    await expect(espState.json()).resolves.toBeNull();
  });
});

describe("ESP power ingest is unaffected by the shadow feed", () => {
  it("POST /api/power/ingest still works and still calls onPowerIngest", async () => {
    const ingestCalls: IngestData[] = [];
    const { server, url } = await startServer({ onPowerIngest: (data) => { ingestCalls.push(data); } });
    servers.push(server);

    const post = await fetch(`${url}/api/power/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 230, i1: 4, i2: 2 }),
    });
    expect(post.status).toBe(200);
    await expect(post.json()).resolves.toEqual({ ok: true });

    // The ESP path drives the leveler...
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0].voltage).toBe(230);

    // ...and updates latestPower, surfaced by the ESP GET.
    const espState = await fetch(`${url}/api/current/power`);
    const body = await espState.json() as { voltage: number } | null;
    expect(body?.voltage).toBe(230);
  });
});
