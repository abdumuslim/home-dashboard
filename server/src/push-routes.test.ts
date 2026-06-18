import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createRouter } from "./routes.js";
import type { Config } from "./config.js";

const TEST_CONFIG: Config = {
  qpAppKey: "", qpAppSecret: "", awApiKey: "", awAppKey: "", databaseUrl: "",
  vapidPublicKey: "", vapidPrivateKey: "", vapidSubject: "",
  mqttBrokerUrl: "", mqttUsername: "", mqttPassword: "", mqttQingpingMac: "",
  miEmail: "", miPassword: "", miRegion: "sg",
  tclUsername: "", tclPassword: "",
  authSecret: "auth-secret", adminUser: "admin", adminPassword: "password",
  hermesApiToken: "",
};

/** Stateful fake pool: stores leveling_notifications per endpoint so set→read round-trips. */
function createLevelingPool() {
  const store = new Map<string, boolean>();
  return {
    seed: (endpoint: string, enabled: boolean) => store.set(endpoint, enabled),
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("UPDATE push_subscriptions SET leveling_notifications")) {
        const [endpoint, enabled] = params as [string, boolean];
        store.set(endpoint, enabled);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT leveling_notifications FROM push_subscriptions")) {
        const [endpoint] = params as [string];
        if (!store.has(endpoint)) return { rows: [], rowCount: 0 };
        return { rows: [{ leveling_notifications: store.get(endpoint) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

async function startServer(pool: ReturnType<typeof createLevelingPool>) {
  const app = express();
  app.use(express.json());
  app.use(createRouter(pool as never, TEST_CONFIG, undefined as never, undefined as never, undefined, undefined as never));
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

describe("/api/push/leveling per-device opt-in", () => {
  it("defaults to disabled when the device has no preference row", async () => {
    const { server, url } = await startServer(createLevelingPool());
    servers.push(server);

    const resp = await fetch(`${url}/api/push/leveling?endpoint=${encodeURIComponent("https://push/abc")}`);
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ enabled: false });
  });

  it("round-trips: POST enabled=true then GET reflects it", async () => {
    const { server, url } = await startServer(createLevelingPool());
    servers.push(server);
    const endpoint = "https://push/device-1";

    const post = await fetch(`${url}/api/push/leveling`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, enabled: true }),
    });
    expect(post.status).toBe(200);
    await expect(post.json()).resolves.toEqual({ ok: true });

    const get = await fetch(`${url}/api/push/leveling?endpoint=${encodeURIComponent(endpoint)}`);
    await expect(get.json()).resolves.toEqual({ enabled: true });
  });

  it("coerces non-boolean enabled to false (only true enables)", async () => {
    const pool = createLevelingPool();
    const { server, url } = await startServer(pool);
    servers.push(server);
    const endpoint = "https://push/device-2";
    pool.seed(endpoint, true);

    await fetch(`${url}/api/push/leveling`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, enabled: "yes" }),
    });

    const get = await fetch(`${url}/api/push/leveling?endpoint=${encodeURIComponent(endpoint)}`);
    await expect(get.json()).resolves.toEqual({ enabled: false });
  });

  it("rejects GET and POST when endpoint is missing", async () => {
    const { server, url } = await startServer(createLevelingPool());
    servers.push(server);

    const get = await fetch(`${url}/api/push/leveling`);
    expect(get.status).toBe(400);

    const post = await fetch(`${url}/api/push/leveling`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(post.status).toBe(400);
  });
});
