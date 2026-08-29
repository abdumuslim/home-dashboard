import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createRouter } from "./routes.js";
import { resolveCt02PowerMeter, type Config } from "./config.js";
import { Ct02Feed } from "./ct02-feed.js";

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

/** Fake pool: swallows every query so the median DB write has somewhere to land. */
function createStubPool() {
  return { query: async () => ({ rows: [], rowCount: 0 }) };
}

type IngestData = Parameters<NonNullable<Parameters<typeof createRouter>[6]>>[0];

async function startServer(options: {
  config?: Config;
  onPowerIngest?: (data: IngestData) => void;
} = {}) {
  const app = express();
  app.use(express.json());
  const router = createRouter(
    createStubPool() as never,
    options.config ?? TEST_CONFIG,
    undefined, undefined, undefined, undefined,
    options.onPowerIngest,
  );
  app.use(router);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  return { server, url: `http://127.0.0.1:${address.port}`, router };
}

const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  })));
});

function postIngest(url: string, body: unknown) {
  return fetch(`${url}/api/power/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const METER_ON: Config = { ...TEST_CONFIG, ct02PowerMeter: true };

describe("resolveCt02PowerMeter", () => {
  it("is true only when the flag is exactly 'true' and a topic base is set", () => {
    expect(resolveCt02PowerMeter("true", "ct02topic")).toBe(true);
    expect(resolveCt02PowerMeter("true", "")).toBe(false);       // no topic -> meterless
    expect(resolveCt02PowerMeter("false", "ct02topic")).toBe(false);
    expect(resolveCt02PowerMeter(undefined, "ct02topic")).toBe(false);
    expect(resolveCt02PowerMeter("TRUE", "ct02topic")).toBe(false); // exact match only
  });
});

describe("CT02 as the active power meter", () => {
  it("refuses the ESP ingest route with 409 and leaves latestPower null", async () => {
    const { server, url } = await startServer({ config: METER_ON });
    servers.push(server);

    const post = await postIngest(url, { v: 211.6, i1: 0.007, i2: 9.144 });
    expect(post.status).toBe(409);
    await expect(post.json()).resolves.toEqual({
      error: "ESP feed retired: CT02 is the active meter (CT02_POWER_METER=true)",
    });

    const power = await fetch(`${url}/api/current/power`);
    await expect(power.json()).resolves.toBeNull();
  });

  it("drives latestPower through the returned ingestPower handle", async () => {
    const { server, url, router } = await startServer({ config: METER_ON });
    servers.push(server);

    router.ingestPower(211.6, 0.007, 9.144); // port A = grid, port B = gen

    const power = await fetch(`${url}/api/current/power`);
    const body = await power.json() as { voltage: number; current_1: number; current_2: number } | null;
    expect(body?.voltage).toBe(211.6);
    expect(body?.current_1).toBe(0.007);
    expect(body?.current_2).toBe(9.144);
  });

  it("fans the CT02 reading out to the leveler with grid/gen mapping", async () => {
    const spy: IngestData[] = [];
    const { server, router } = await startServer({ config: METER_ON, onPowerIngest: (d) => spy.push(d) });
    servers.push(server);

    router.ingestPower(211.6, 0.007, 9.144);
    expect(spy).toHaveLength(1);
    expect(spy[0].voltage).toBe(211.6);
    expect(spy[0].current_1).toBe(0.007); // port A = grid
    expect(spy[0].current_2).toBe(9.144); // port B = gen
  });

  it("throttles the leveler fan-out while latestPower keeps every reading", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = new Date("2026-08-29T00:00:00.000Z").getTime();
    vi.setSystemTime(base);

    const spy: IngestData[] = [];
    const { server, url, router } = await startServer({ config: METER_ON, onPowerIngest: (d) => spy.push(d) });
    servers.push(server);

    router.ingestPower(211.6, 0.007, 9.144); // t0: forwarded to the leveler
    vi.setSystemTime(base + 1000);
    router.ingestPower(220, 1, 2);           // t0+1s: inside the 4s window, not forwarded

    // latestPower reflects the SECOND reading (fast path runs every call)...
    const power = await fetch(`${url}/api/current/power`);
    const body = await power.json() as { voltage: number; current_1: number; current_2: number } | null;
    expect(body?.voltage).toBe(220);
    expect(body?.current_1).toBe(1);
    expect(body?.current_2).toBe(2);

    // ...but the leveler saw only the first.
    expect(spy).toHaveLength(1);
    expect(spy[0].voltage).toBe(211.6);
    expect(spy[0].current_1).toBe(0.007);
    expect(spy[0].current_2).toBe(9.144);
  });

  it("rejects an out-of-range reading without touching latestPower or the leveler", async () => {
    const spy: IngestData[] = [];
    const { server, url, router } = await startServer({ config: METER_ON, onPowerIngest: (d) => spy.push(d) });
    servers.push(server);

    router.ingestPower(211.6, 0.007, 999); // i2 far over the 200 A bound
    expect(spy).toHaveLength(0);
    const power = await fetch(`${url}/api/current/power`);
    await expect(power.json()).resolves.toBeNull();
  });

  it("wires a real Ct02Feed onReading into the pipeline, as index.ts does", async () => {
    const spy: IngestData[] = [];
    const { server, url, router } = await startServer({ config: METER_ON, onPowerIngest: (d) => spy.push(d) });
    servers.push(server);

    const feed = new Ct02Feed({
      brokerUrl: "mqtt://test:1883", username: "u", password: "p", topicBase: "ct02test",
      onReading: (r) => router.ingestPower(r.v, r.i1, r.i2),
    });
    feed.handleMessage("ct02test/0/get", "21160");
    feed.handleMessage("ct02test/3/get", "7");
    feed.handleMessage("ct02test/4/get", "9144");

    const power = await fetch(`${url}/api/current/power`);
    const body = await power.json() as { voltage: number; current_1: number; current_2: number } | null;
    expect(body?.voltage).toBe(211.6);
    expect(body?.current_1).toBe(0.007);
    expect(body?.current_2).toBe(9.144);
    expect(spy).toHaveLength(1);
    expect(spy[0].current_1).toBe(0.007);
    expect(spy[0].current_2).toBe(9.144);
  });

  it("still ingests over HTTP when the flag is off (regression guard)", async () => {
    const { server, url } = await startServer(); // ct02PowerMeter defaults false
    servers.push(server);

    const post = await postIngest(url, { v: 230, i1: 4, i2: 2 });
    expect(post.status).toBe(200);
    await expect(post.json()).resolves.toEqual({ ok: true });

    const power = await fetch(`${url}/api/current/power`);
    const body = await power.json() as { voltage: number } | null;
    expect(body?.voltage).toBe(230);
  });
});
