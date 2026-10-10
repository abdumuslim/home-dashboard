// Route tests for POST /api/ac/devices/:id/off-when-online (2026-10-09 "turn off
// once back online" for the grid-only Guest AC). The route validates, arms or
// disarms, and answers only once the arm file holds the change (L6, durable
// acknowledgement); the collector's off-when-online step sends the OFF. Auth is
// real here (a locally minted cookie goes through requireAuth), so the 401 case
// exercises the actual middleware.
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createRouter } from "./routes.js";
import type { Config } from "./config.js";
import { signToken } from "./auth.js";
import { listenOnFetchSafePort } from "./test-http.js";

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

const GUEST = "DlXqDBFAAAE";
const NAJAT = "DHihohFAAAE";
/** A Smart AC Leveling room (real policy, leveling-eligible), offline in the fake. */
const ABDU = "CA5IMhFAAAE";

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function createRecordingPool() {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    audits: () => queries.filter((q) => q.sql.includes("INSERT INTO ac_control_audit")),
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
}

interface CloudOptions {
  ready?: boolean;
  /** Value isOffWhenOnlineArmed answers; the route must echo it, not the request. */
  armed?: boolean;
  /** The arm-file write behind setOffWhenOnline (default: completes at once). */
  write?: () => Promise<void>;
}

function createCloud(options: CloudOptions = {}) {
  const setCalls: Array<{ deviceId: string; enabled: boolean }> = [];
  const cloud = {
    isReady: () => options.ready ?? true,
    getDevices: () => [
      { id: GUEST, name: "Guest", isOnline: false },
      { id: NAJAT, name: "Najat", isOnline: true },
      { id: ABDU, name: "Abdu", isOnline: false },
    ],
    setOffWhenOnline: (deviceId: string, enabled: boolean): Promise<void> => {
      setCalls.push({ deviceId, enabled });
      return options.write?.() ?? Promise.resolve();
    },
    isOffWhenOnlineArmed: (_deviceId: string) => options.armed ?? true,
  };
  return { cloud, setCalls };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  })));
});

async function start(getTclCloud: (() => unknown) | undefined, pool = createRecordingPool()) {
  const app = express();
  app.use(express.json());
  app.use(createRouter(
    pool as never,
    TEST_CONFIG,
    undefined,
    getTclCloud as never,
  ));
  const server = await listenOnFetchSafePort(app);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  return { url: `http://127.0.0.1:${address.port}`, pool };
}

const cookie = () => `auth=${signToken({ user: "admin", exp: Date.now() + 60_000 }, TEST_CONFIG.authSecret)}`;

function post(url: string, id: string, body: unknown, headers: Record<string, string> = { Cookie: cookie() }) {
  return fetch(`${url}/api/ac/devices/${id}/off-when-online`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ac/devices/:id/off-when-online", () => {
  it("rejects an unauthenticated request with 401 and touches nothing", async () => {
    const { cloud, setCalls } = createCloud();
    const { url, pool } = await start(() => cloud);

    const resp = await post(url, GUEST, { enabled: true }, {});

    expect(resp.status).toBe(401);
    expect(setCalls).toEqual([]);
    expect(pool.audits()).toEqual([]);
  });

  it("503 when no TCL cloud is configured", async () => {
    const { url } = await start(undefined);
    expect((await post(url, GUEST, { enabled: true })).status).toBe(503);
  });

  it("503 when getTclCloud returns null", async () => {
    const { url } = await start(() => null);
    expect((await post(url, GUEST, { enabled: true })).status).toBe(503);
  });

  it("503 when the cloud is not ready, and nothing is armed or audited", async () => {
    const { cloud, setCalls } = createCloud({ ready: false });
    const { url, pool } = await start(() => cloud);

    const resp = await post(url, GUEST, { enabled: true });

    expect(resp.status).toBe(503);
    expect(setCalls).toEqual([]);
    expect(pool.audits()).toEqual([]);
  });

  it.each([
    ["missing", {}],
    ["the string \"true\"", { enabled: "true" }],
    ["the number 1", { enabled: 1 }],
    ["the number 0", { enabled: 0 }],
    ["null", { enabled: null }],
  ])("400 when enabled is %s, with no arm and no audit", async (_label, body) => {
    const { cloud, setCalls } = createCloud();
    const { url, pool } = await start(() => cloud);

    const resp = await post(url, GUEST, body);

    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error?: string }).error).toMatch(/enabled/);
    expect(setCalls).toEqual([]);
    expect(pool.audits()).toEqual([]);
  });

  it("404 for an id that is not in cloud.getDevices()", async () => {
    const { cloud, setCalls } = createCloud();
    const { url, pool } = await start(() => cloud);

    const resp = await post(url, "nope", { enabled: true });

    expect(resp.status).toBe(404);
    expect(setCalls).toEqual([]);
    expect(pool.audits()).toEqual([]);
  });

  it("409 when arming a device that is online, and setOffWhenOnline is NOT called", async () => {
    const { cloud, setCalls } = createCloud();
    const { url, pool } = await start(() => cloud);

    const resp = await post(url, NAJAT, { enabled: true });

    expect(resp.status).toBe(409);
    expect(setCalls).toEqual([]);
    expect(pool.audits(), "a refused arm is not an audited command").toEqual([]);
  });

  it("200 arming an offline device: arms it, echoes isOffWhenOnlineArmed, audits off_when_online=1", async () => {
    const { cloud, setCalls } = createCloud({ armed: true });
    const { url, pool } = await start(() => cloud);

    const resp = await post(url, GUEST, { enabled: true }, {
      Cookie: cookie(),
      "user-agent": "iPhone",
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, offWhenOnline: true });
    expect(setCalls).toEqual([{ deviceId: GUEST, enabled: true }]);
    const audits = pool.audits();
    expect(audits).toHaveLength(1);
    const [deviceId, command, value, authKind, , userAgent] = audits[0].params as string[];
    expect(deviceId).toBe(GUEST);
    expect(command).toBe("off_when_online");
    expect(value).toBe("1");
    expect(authKind).toBe("user");
    expect(userAgent).toBe("iPhone");
  });

  it("answers with the value the cloud reports, not the requested one", async () => {
    // The cloud is the source of truth (it could have refused or already fired).
    const { cloud } = createCloud({ armed: false });
    const { url } = await start(() => cloud);

    const resp = await post(url, GUEST, { enabled: true });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, offWhenOnline: false });
  });

  it("200 disarming works even while the device is online, audits value 0", async () => {
    const { cloud, setCalls } = createCloud({ armed: false });
    const { url, pool } = await start(() => cloud);

    const resp = await post(url, NAJAT, { enabled: false });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, offWhenOnline: false });
    expect(setCalls).toEqual([{ deviceId: NAJAT, enabled: false }]);
    const audits = pool.audits();
    expect(audits).toHaveLength(1);
    const [deviceId, command, value] = audits[0].params as string[];
    expect(deviceId).toBe(NAJAT);
    expect(command).toBe("off_when_online");
    expect(value).toBe("0");
  });

  it("disarming an offline device is also allowed", async () => {
    const { cloud, setCalls } = createCloud({ armed: false });
    const { url } = await start(() => cloud);

    const resp = await post(url, GUEST, { enabled: false });

    expect(resp.status).toBe(200);
    expect(setCalls).toEqual([{ deviceId: GUEST, enabled: false }]);
  });

  // C2 (2026-10-10): the feature is for ACs outside Smart AC Leveling only. A
  // deferred OFF on a leveled room bypasses the leveler's user-OFF bookkeeping
  // and reads as an unexplained draw change (hard rule 5b class).
  it("409 arming an offline Smart AC Leveling AC: setOffWhenOnline NOT called, no audit", async () => {
    const { cloud, setCalls } = createCloud();
    const { url, pool } = await start(() => cloud);

    const resp = await post(url, ABDU, { enabled: true });

    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error?: string }).error).toMatch(/Smart AC Leveling/);
    expect(setCalls).toEqual([]);
    expect(pool.audits(), "a refused arm is not an audited command").toEqual([]);
  });

  it("disarming a Smart AC Leveling AC is still 200, so a stale arm can always be cleared", async () => {
    const { cloud, setCalls } = createCloud({ armed: false });
    const { url, pool } = await start(() => cloud);

    const resp = await post(url, ABDU, { enabled: false });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, offWhenOnline: false });
    expect(setCalls).toEqual([{ deviceId: ABDU, enabled: false }]);
    const [deviceId, command, value] = pool.audits()[0].params as string[];
    expect([deviceId, command, value]).toEqual([ABDU, "off_when_online", "0"]);
  });

  // L6 (Astra F8): the answer is a durable acknowledgement.
  it("answers only once the arm-file write holding the change has completed", async () => {
    let finishWrite: () => void = () => undefined;
    const { cloud, setCalls } = createCloud({
      write: () => new Promise<void>((resolve) => { finishWrite = resolve; }),
    });
    const { url } = await start(() => cloud);

    let answered = false;
    const responding = post(url, GUEST, { enabled: true }).then((resp) => {
      answered = true;
      return resp;
    });
    for (let i = 0; i < 50 && setCalls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(setCalls).toEqual([{ deviceId: GUEST, enabled: true }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);

    finishWrite();
    const resp = await responding;
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, offWhenOnline: true });
  });

  it("500 with a clear message when the arm cannot be saved; the arm stays in memory and the body says so", async () => {
    const { cloud } = createCloud({
      armed: true,
      write: () => Promise.reject(new Error("ENOSPC: no space left on device")),
    });
    const { url } = await start(() => cloud);

    const resp = await post(url, GUEST, { enabled: true });

    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { error?: string; detail?: string; offWhenOnline?: boolean };
    expect(body.error).toMatch(/could not be saved/);
    expect(body.error).toMatch(/restart/);
    expect(body.detail).toMatch(/ENOSPC/);
    expect(body.offWhenOnline).toBe(true);
  });

  it("500 when a cancel cannot be saved: the cancel holds in memory, and the message says the arm can come back", async () => {
    const { cloud } = createCloud({
      armed: false,
      write: () => Promise.reject(new Error("EROFS: read-only file system")),
    });
    const { url } = await start(() => cloud);

    const resp = await post(url, GUEST, { enabled: false });

    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { error?: string; offWhenOnline?: boolean };
    expect(body.error).toMatch(/Cancelled/);
    expect(body.error).toMatch(/restart/);
    expect(body.offWhenOnline).toBe(false);
  });
});
