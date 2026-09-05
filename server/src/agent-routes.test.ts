import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createRouter, resetXiaomiReloginCooldownForTests } from "./routes.js";
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
  onXiaomiRelogin?: () => void;
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
    undefined, // onPowerIngest
    undefined, // onAutomationRulesChanged
    undefined, // acManualOffLocks
    undefined, // acLeveling
    undefined, // acCalibration
    undefined, // getLoopAgeMs
    options.onXiaomiRelogin,
  ));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const servers: Server[] = [];

// The relogin cooldown is module-level state in routes.ts, so it would otherwise
// leak from one case into the next.
beforeEach(() => {
  resetXiaomiReloginCooldownForTests();
});

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
        isReady: () => true,
        getAuthStatus: () => ({ status: "authenticated" }),
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
    expect(body.devices.purifiers.available).toBe(true);
    expect(body.devices.ac.devices).toHaveLength(1);
    expect(body.acTimers).toEqual([]);
    expect(body.automations).toEqual([{ id: 7, name: "AC Schedule" }]);
    expect(body.forecast.generatedAt).toBe(now.toISOString());
    expect(body.prayerTimes.prayers).toBeDefined();
  });
});

// Regression cover for the 2026-08-31 auth wedge: the token died at 15:04Z and
// for 1h25m /api/devices answered {"devices":[],"available":true} while the
// purifiers were gone from the UI. Availability must follow isReady(), and a
// live cache must never be served as an empty list.
const CACHED_PURIFIERS = [
  { id: "317499063", name: "Abdu", model: "zhimi.airpurifier.vb2", isOnline: true },
  { id: "357465941", name: "mom", model: "zhimi.airpurifier.v7", isOnline: true },
];

/** Xiaomi cloud with a dead serviceToken and a last-known-good device cache. */
function createWedgedXiaomiCloud(overrides: Record<string, unknown> = {}) {
  return {
    isReady: () => false,
    getAuthStatus: () => ({ status: "error", error: "serviceToken expired (401)" }),
    getDevices: () => CACHED_PURIFIERS,
    getRegion: () => "sg",
    // Matches the real class: an unauthenticated call resolves with the cache.
    fetchDevicesLive: async () => CACHED_PURIFIERS,
    invalidateAuth: async () => {},
    ...overrides,
  };
}

describe("Xiaomi cloud availability", () => {
  it("reports /api/devices unavailable with the cached purifiers when the token is dead", async () => {
    const { server, url } = await startServer({
      getXiaomiCloud: () => createWedgedXiaomiCloud(),
    });
    servers.push(server);

    const resp = await fetch(`${url}/api/devices`, {
      headers: { Authorization: "Bearer hermes-secret" },
    });
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.authStatus).toBe("error");
    expect(body.region).toBe("sg");
    expect(body.devices).toHaveLength(2);
    expect(body.devices.map((d: { id: string }) => d.id)).toEqual(["317499063", "357465941"]);
  });

  it("serves the cached purifiers with an error when the device fetch rejects", async () => {
    const { server, url } = await startServer({
      getXiaomiCloud: () => createWedgedXiaomiCloud({
        fetchDevicesLive: async () => { throw new Error("Request error with status Unauthorized"); },
      }),
    });
    servers.push(server);

    const resp = await fetch(`${url}/api/devices`, {
      headers: { Authorization: "Bearer hermes-secret" },
    });
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.authStatus).toBe("error");
    expect(body.error).toContain("Unauthorized");
    expect(body.devices).toHaveLength(2);
  });

  it("reports purifiers unavailable in the agent snapshot when the cloud is not ready", async () => {
    const { server, url } = await startServer({
      getXiaomiCloud: () => createWedgedXiaomiCloud(),
    });
    servers.push(server);

    const resp = await fetch(`${url}/api/agent/snapshot`, {
      headers: { Authorization: "Bearer hermes-secret" },
    });
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.devices.purifiers.available).toBe(false);
    expect(body.devices.purifiers.authStatus).toBe("error");
    expect(body.devices.purifiers.devices).toEqual([]);
  });

  it("invalidates auth exactly once on POST /api/xiaomi/relogin", async () => {
    let invalidateCalls = 0;
    const { server, url } = await startServer({
      getXiaomiCloud: () => createWedgedXiaomiCloud({
        invalidateAuth: async () => { invalidateCalls += 1; },
      }),
    });
    servers.push(server);

    const resp = await fetch(`${url}/api/xiaomi/relogin`, {
      method: "POST",
      headers: { Authorization: "Bearer hermes-secret" },
    });

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ ok: true });
    expect(invalidateCalls).toBe(1);
  });

  // The relogin button is one click away from a full fresh login, and sustained
  // login volume is what makes Xiaomi answer with a captcha (which needs a human).
  // A global cooldown keeps the button from outrunning the re-auth backoff ladder.
  it("rejects a second POST /api/xiaomi/relogin inside the cooldown window with 429", async () => {
    let invalidateCalls = 0;
    const { server, url } = await startServer({
      getXiaomiCloud: () => createWedgedXiaomiCloud({
        invalidateAuth: async () => { invalidateCalls += 1; },
      }),
    });
    servers.push(server);

    const first = await fetch(`${url}/api/xiaomi/relogin`, {
      method: "POST",
      headers: { Authorization: "Bearer hermes-secret" },
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${url}/api/xiaomi/relogin`, {
      method: "POST",
      headers: { Authorization: "Bearer hermes-secret" },
    });
    const body = await second.json();

    expect(second.status).toBe(429);
    expect(body.error).toContain("Next retry allowed in");
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(body.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(invalidateCalls).toBe(1);
  });

  it("accepts POST /api/xiaomi/relogin again once the cooldown window has elapsed", async () => {
    let invalidateCalls = 0;
    const { server, url } = await startServer({
      getXiaomiCloud: () => createWedgedXiaomiCloud({
        invalidateAuth: async () => { invalidateCalls += 1; },
      }),
    });
    servers.push(server);

    const first = await fetch(`${url}/api/xiaomi/relogin`, {
      method: "POST",
      headers: { Authorization: "Bearer hermes-secret" },
    });
    expect(first.status).toBe(200);

    // Shift the clock past the window instead of waiting it out; the offset keeps
    // time moving so the live HTTP server is unaffected.
    const realNow = Date.now;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow.call(Date) + 61_000);
    try {
      const second = await fetch(`${url}/api/xiaomi/relogin`, {
        method: "POST",
        headers: { Authorization: "Bearer hermes-secret" },
      });
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toEqual({ ok: true });
    } finally {
      nowSpy.mockRestore();
    }

    expect(invalidateCalls).toBe(2);
  });

  // The endpoint exists to rescue a WEDGED session, so an accepted call has to
  // reach the collector: mid-ladder its backoff can be a 15-minute rung, and
  // {ok:true} followed by a quarter of an hour of nothing is a lie told in
  // exactly the situation the button is for.
  it("hands an accepted POST /api/xiaomi/relogin to the collector exactly once", async () => {
    let invalidateCalls = 0;
    let reloginRequests = 0;
    const { server, url } = await startServer({
      getXiaomiCloud: () => createWedgedXiaomiCloud({
        invalidateAuth: async () => { invalidateCalls += 1; },
      }),
      onXiaomiRelogin: () => { reloginRequests += 1; },
    });
    servers.push(server);

    const resp = await fetch(`${url}/api/xiaomi/relogin`, {
      method: "POST",
      headers: { Authorization: "Bearer hermes-secret" },
    });

    expect(resp.status).toBe(200);
    expect(invalidateCalls).toBe(1);
    expect(reloginRequests).toBe(1);
  });

  // Dropping a working session recovers nothing, and one accepted call per minute
  // against a healthy cloud is a 60 logins/hour storm of its own.
  it("refuses POST /api/xiaomi/relogin with 409 while the session is healthy", async () => {
    let invalidateCalls = 0;
    let reloginRequests = 0;
    const { server, url } = await startServer({
      getXiaomiCloud: () => createWedgedXiaomiCloud({
        isReady: () => true,
        getAuthStatus: () => ({ status: "authenticated" }),
        invalidateAuth: async () => { invalidateCalls += 1; },
      }),
      onXiaomiRelogin: () => { reloginRequests += 1; },
    });
    servers.push(server);

    const resp = await fetch(`${url}/api/xiaomi/relogin`, {
      method: "POST",
      headers: { Authorization: "Bearer hermes-secret" },
    });
    const body = await resp.json();

    expect(resp.status).toBe(409);
    expect(body.error).toContain("already healthy");
    expect(invalidateCalls).toBe(0);
    expect(reloginRequests).toBe(0);
  });

  it("does not spend the relogin cooldown on a refusal", async () => {
    let healthy = true;
    let invalidateCalls = 0;
    const { server, url } = await startServer({
      getXiaomiCloud: () => createWedgedXiaomiCloud({
        isReady: () => healthy,
        invalidateAuth: async () => { invalidateCalls += 1; },
      }),
    });
    servers.push(server);

    const refused = await fetch(`${url}/api/xiaomi/relogin`, {
      method: "POST",
      headers: { Authorization: "Bearer hermes-secret" },
    });
    expect(refused.status).toBe(409);

    // The session wedges a moment later: the refusal must not have cost the
    // operator the one accepted retry in the window.
    healthy = false;
    const accepted = await fetch(`${url}/api/xiaomi/relogin`, {
      method: "POST",
      headers: { Authorization: "Bearer hermes-secret" },
    });

    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ ok: true });
    expect(invalidateCalls).toBe(1);
  });

  it("returns 503 from POST /api/xiaomi/relogin when no Xiaomi cloud is configured", async () => {
    const { server, url } = await startServer();
    servers.push(server);

    const resp = await fetch(`${url}/api/xiaomi/relogin`, {
      method: "POST",
      headers: { Authorization: "Bearer hermes-secret" },
    });

    expect(resp.status).toBe(503);
    await expect(resp.json()).resolves.toEqual({ error: "Xiaomi Cloud not available" });
  });
});
