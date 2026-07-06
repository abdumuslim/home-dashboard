import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createRouter } from "./routes.js";
import type { Config } from "./config.js";
import { verifyToken } from "./auth.js";

const TEST_CONFIG: Config = {
  qpAppKey: "",
  qpAppSecret: "",
  awApiKey: "",
  awAppKey: "",
  databaseUrl: "",
  vapidPublicKey: "",
  vapidPrivateKey: "",
  vapidSubject: "",
  mqttBrokerUrl: "",
  mqttUsername: "",
  mqttPassword: "",
  mqttQingpingMac: "",
  miEmail: "",
  miPassword: "",
  miRegion: "sg",
  tclUsername: "",
  tclPassword: "",
  authSecret: "auth-secret",
  adminUser: "admin",
  adminPassword: "password",
  hermesApiToken: "hermes-secret",
  observedOffLocks: true,
};

function createMockPool(rowsBySql: Array<{ match: string; rows: unknown[] }> = []) {
  return {
    query: async (sql: string) => {
      const hit = rowsBySql.find((entry) => sql.includes(entry.match));
      return { rows: hit?.rows ?? [], rowCount: hit?.rows.length ?? 0 };
    },
  };
}

async function startServer(options: {
  config?: Config;
  pool?: ReturnType<typeof createMockPool>;
  getLatestAir?: () => Record<string, unknown> | null;
  getForecast?: () => Record<string, unknown> | null;
  getXiaomiCloud?: () => unknown;
  getTclCloud?: () => unknown;
} = {}) {
  const app = express();
  app.use(express.json());
  app.use(createRouter(
    (options.pool ?? createMockPool()) as never,
    options.config ?? TEST_CONFIG,
    options.getXiaomiCloud as never,
    options.getTclCloud as never,
    options.getLatestAir,
    options.getForecast as never,
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
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  })));
});

describe("Hermes agent access", () => {
  it("authenticates protected routes with a valid Hermes bearer token", async () => {
    const { server, url } = await startServer({
      pool: createMockPool([{ match: "SELECT * FROM automations", rows: [{ id: 1, name: "Test" }] }]),
    });
    servers.push(server);

    const resp = await fetch(`${url}/api/automations`, {
      headers: { Authorization: "Bearer hermes-secret" },
    });

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ automations: [{ id: 1, name: "Test" }] });
  });

  it("rejects protected routes when Hermes bearer token is missing or wrong", async () => {
    const { server, url } = await startServer();
    servers.push(server);

    const missing = await fetch(`${url}/api/automations`);
    const wrong = await fetch(`${url}/api/automations`, {
      headers: { Authorization: "Bearer wrong-token" },
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it("does not enable bearer auth when Hermes token config is empty", async () => {
    const { server, url } = await startServer({
      config: { ...TEST_CONFIG, hermesApiToken: "" },
    });
    servers.push(server);

    const resp = await fetch(`${url}/api/automations`, {
      headers: { Authorization: "Bearer hermes-secret" },
    });

    expect(resp.status).toBe(401);
  });

  it("creates an admin browser session only for a valid Hermes bearer token", async () => {
    const { server, url } = await startServer();
    servers.push(server);

    const rejected = await fetch(`${url}/api/agent/session`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("set-cookie")).toBeNull();

    const accepted = await fetch(`${url}/api/agent/session`, {
      method: "POST",
      headers: { Authorization: "Bearer hermes-secret" },
    });
    const cookie = accepted.headers.get("set-cookie");

    expect(accepted.status).toBe(200);
    expect(cookie).toContain("auth=");
    expect(cookie).toContain("HttpOnly");
    const token = cookie?.match(/auth=([^;]+)/)?.[1] ?? "";
    expect(verifyToken(token, TEST_CONFIG.authSecret)?.user).toBe(TEST_CONFIG.adminUser);
  });

  it("still accepts the existing admin cookie auth for protected routes", async () => {
    const { server, url } = await startServer({
      pool: createMockPool([{ match: "SELECT * FROM automations", rows: [{ id: 2, name: "Cookie Auth" }] }]),
    });
    servers.push(server);

    const login = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "password" }),
    });
    const cookie = login.headers.get("set-cookie");
    const resp = await fetch(`${url}/api/automations`, {
      headers: { Cookie: cookie ?? "" },
    });

    expect(login.status).toBe(200);
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ automations: [{ id: 2, name: "Cookie Auth" }] });
  });

  it("returns a consolidated dashboard snapshot for Hermes", async () => {
    const now = new Date("2026-05-22T10:00:00.000Z");
    const { server, url } = await startServer({
      pool: createMockPool([
        { match: "SELECT * FROM weather_readings", rows: [{ ts: now, temp_c: 30 }] },
        { match: "SELECT MAX(wind_gust_kmh)", rows: [{ max_gust: 22 }] },
        { match: "SELECT * FROM automations", rows: [{ id: 7, name: "AC Schedule" }] },
      ]),
      getLatestAir: () => ({ ts: now.toISOString(), co2: 600 }),
      getForecast: () => ({ generatedAt: now.toISOString(), hourly: [] }),
      getXiaomiCloud: () => ({
        getRegion: () => "sg",
        fetchDevicesLive: async () => [{ id: "purifier-1", name: "Abdu", power: "on" }],
        getDevices: () => [],
      }),
      getTclCloud: () => ({
        isReady: () => true,
        fetchDevicesLive: async () => [{ id: "ac-1", name: "Abdu AC", power: true }],
        getDevices: () => [],
      }),
    });
    servers.push(server);

    const resp = await fetch(`${url}/api/agent/snapshot`, {
      headers: { Authorization: "Bearer hermes-secret" },
    });
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.current.weather.temp_c).toBe(30);
    expect(body.current.air.co2).toBe(600);
    expect(body.devices.purifiers.devices).toHaveLength(1);
    expect(body.devices.ac.devices).toHaveLength(1);
    expect(body.acTimers).toEqual([]);
    expect(body.automations).toEqual([{ id: 7, name: "AC Schedule" }]);
    expect(body.forecast.generatedAt).toBe(now.toISOString());
    expect(body.prayerTimes.prayers).toBeDefined();
  });
});
