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
  observedOffLocks: true,
};

/** Fake pool answering the power-stats minute-stream query by SQL substring. */
function createPowerPool() {
  const now = Date.now();
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM power_readings")) {
        // pg returns ts as a Date — the fixture must too.
        return {
          rows: [
            { ts: new Date(now - 3 * 60_000), current_1: 6, current_2: 0 },
            { ts: new Date(now - 2 * 60_000), current_1: 6, current_2: 0 },
            { ts: new Date(now - 1 * 60_000), current_1: 6, current_2: 0 },
          ],
          rowCount: 3,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

async function startServer(pool: ReturnType<typeof createPowerPool>) {
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
    server.close((err) => (err ? reject(err) : resolve()));
  })));
});

describe("GET /api/power/stats", () => {
  it("returns the full PowerStatsPayload shape", async () => {
    const { server, url } = await startServer(createPowerPool());
    servers.push(server);

    const resp = await fetch(`${url}/api/power/stats`);
    expect(resp.status).toBe(200);
    const body = await resp.json();

    // latestPower is closure-internal and null in tests -> live source "none".
    expect(body.source).toBe("none");
    expect(typeof body.generatedAt).toBe("string");
    expect(typeof body.sessionMinutes).toBe("number");
    expect(typeof body.gridHours24h).toBe("number");
    expect(body).toHaveProperty("sessionStartTs");
    expect(body).toHaveProperty("expectedRemainingMinutes");
    expect(typeof body.predictionSampleDays).toBe("number");
    expect(body).toHaveProperty("predictionMethod"); // null under the fake pool's 3-minute window
    expect(body).toHaveProperty("avgGridSessionHours");
    expect(body).toHaveProperty("avgGenSessionHours");
  });
});

describe("GET /api/power/day-breakdown", () => {
  it("returns days + totals for a valid range", async () => {
    const { server, url } = await startServer(createPowerPool());
    servers.push(server);

    const resp = await fetch(`${url}/api/power/day-breakdown?range=24h`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.range).toBe("24h");
    expect(Array.isArray(body.days)).toBe(true);
    expect(body.totals).toHaveProperty("gridHours");
    expect(body.totals).toHaveProperty("genHours");
    expect(body.totals).toHaveProperty("offHours");
  });

  it("accepts every RANGE_MAP key", async () => {
    const { server, url } = await startServer(createPowerPool());
    servers.push(server);
    for (const range of ["6h", "24h", "25h", "48h", "1w", "30d"]) {
      const resp = await fetch(`${url}/api/power/day-breakdown?range=${range}`);
      expect(resp.status, `range=${range}`).toBe(200);
    }
  });

  it("rejects an invalid range with 400", async () => {
    const { server, url } = await startServer(createPowerPool());
    servers.push(server);
    const resp = await fetch(`${url}/api/power/day-breakdown?range=bogus`);
    expect(resp.status).toBe(400);
  });
});
