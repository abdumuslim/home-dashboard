import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createRouter, type AcManualOffLockHandlers } from "./routes.js";
import type { Config } from "./config.js";
import { signToken, verifyToken } from "./auth.js";

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

interface LockCall {
  deviceId: string;
  authKind: string;
  ip: string;
}

function createLockHandlers(lockedIds: string[] = []) {
  const locked = new Set(lockedIds);
  const cleared: string[] = [];
  const notified: LockCall[] = [];
  const handlers: AcManualOffLockHandlers = {
    record: async (deviceId) => { locked.add(deviceId); },
    // Mirrors collector.clearAcManualOff: the atomic delete reports the release.
    clear: async (deviceId) => {
      const released = locked.delete(deviceId);
      if (released) cleared.push(deviceId);
      return released;
    },
    isLocked: async (deviceId) => locked.has(deviceId),
    getLockedIds: async () => new Set(locked),
    reconcileDevices: async () => new Set(locked),
    notifyLockCleared: (deviceId, authKind, ip) => { notified.push({ deviceId, authKind, ip }); },
  };
  return { handlers, cleared, notified, locked };
}

function createTclMock() {
  const sent: Array<{ deviceId: string; command: string; value: unknown }> = [];
  return {
    sent,
    cloud: {
      isReady: () => true,
      getDevices: () => [{ id: "DHihohFAAAE", name: "Najat" }],
      sendControlVerified: async (deviceId: string, command: string, value: unknown) => {
        sent.push({ deviceId, command, value });
      },
    },
  };
}

async function startServer(options: {
  pool?: ReturnType<typeof createRecordingPool>;
  locks?: AcManualOffLockHandlers;
  tcl?: ReturnType<typeof createTclMock>["cloud"];
  config?: Config;
} = {}) {
  const app = express();
  app.use(express.json());
  app.use(createRouter(
    (options.pool ?? createRecordingPool()) as never,
    options.config ?? TEST_CONFIG,
    undefined,
    (options.tcl ? () => options.tcl : undefined) as never,
    undefined,
    undefined,
    undefined,
    undefined,
    options.locks,
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

/** Cookies are minted locally: the login endpoint's 5-per-15-min rate limiter is
 * module-level state shared by every test in this file. The two tests below that
 * assert the claim shape exercise the real endpoints. */
function cookieFor(kind: "user" | "agent"): string {
  const payload = kind === "agent"
    ? { user: "admin", agent: true, exp: Date.now() + 60_000 }
    : { user: "admin", exp: Date.now() + 60_000 };
  return `auth=${signToken(payload, TEST_CONFIG.authSecret)}`;
}

const loginCookie = () => cookieFor("user");
const agentCookie = () => cookieFor("agent");

function control(url: string, headers: Record<string, string>, command: string, value: unknown) {
  return fetch(`${url}/api/ac/devices/DHihohFAAAE/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ command, value }),
  });
}

describe("AC control attribution (2026-07-24 'Najat keeps turning back on')", () => {
  it("/api/agent/session mints a session carrying the agent claim", async () => {
    const { server, url } = await startServer();
    servers.push(server);

    const session = await fetch(`${url}/api/agent/session`, {
      method: "POST",
      headers: { Authorization: "Bearer hermes-secret" },
    });
    const token = session.headers.get("set-cookie")?.match(/auth=([^;]+)/)?.[1] ?? "";
    const payload = verifyToken(token, TEST_CONFIG.authSecret);

    expect(payload?.user).toBe("admin");
    expect(payload?.agent).toBe(true);
  });

  it("/api/auth/login does not tag a human session as an agent", async () => {
    const { server, url } = await startServer();
    servers.push(server);

    const login = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "password" }),
    });
    const token = login.headers.get("set-cookie")?.match(/auth=([^;]+)/)?.[1] ?? "";

    expect(login.status).toBe(200);
    expect(verifyToken(token, TEST_CONFIG.authSecret)?.agent).toBeUndefined();
  });

  it("audits a human control with auth_kind=user and the forwarded client IP", async () => {
    const pool = createRecordingPool();
    const tcl = createTclMock();
    const { server, url } = await startServer({ pool, tcl: tcl.cloud });
    servers.push(server);

    const cookie = loginCookie();
    // Production shape: Cloudflare sets cf-connecting-ip, and Traefik appends its
    // immediate peer (a Cloudflare edge IP) as the rightmost X-Forwarded-For hop —
    // which is what proves the request transited CF, so cf-connecting-ip is trusted.
    const resp = await control(
      url,
      { Cookie: cookie, "cf-connecting-ip": "5.6.7.8", "x-forwarded-for": "5.6.7.8, 162.158.1.1", "user-agent": "iPhone" },
      "set_power",
      1,
    );

    expect(resp.status).toBe(200);
    const audits = pool.audits();
    expect(audits).toHaveLength(1);
    const [deviceId, command, value, authKind, ip, userAgent] = audits[0].params as string[];
    expect(deviceId).toBe("DHihohFAAAE");
    expect(command).toBe("set_power");
    expect(value).toBe("1");
    expect(authKind).toBe("user");
    expect(ip).toBe("5.6.7.8");
    expect(userAgent).toBe("iPhone");
  });

  it("audits an agent-session control as auth_kind=agent", async () => {
    const pool = createRecordingPool();
    const tcl = createTclMock();
    const { server, url } = await startServer({ pool, tcl: tcl.cloud });
    servers.push(server);

    const cookie = agentCookie();
    await control(url, { Cookie: cookie }, "set_power", 1);

    expect((pool.audits()[0].params as string[])[3]).toBe("agent");
  });

  it("audits a bearer-token control as auth_kind=agent", async () => {
    const pool = createRecordingPool();
    const tcl = createTclMock();
    const { server, url } = await startServer({ pool, tcl: tcl.cloud });
    servers.push(server);

    await control(url, { Authorization: "Bearer hermes-secret" }, "set_temperature", 22);

    const audits = pool.audits();
    expect((audits[0].params as string[])[1]).toBe("set_temperature");
    expect((audits[0].params as string[])[3]).toBe("agent");
  });

  it("pushes when a commanded ON releases a manual-off lock", async () => {
    const pool = createRecordingPool();
    const tcl = createTclMock();
    const locks = createLockHandlers(["DHihohFAAAE"]);
    const { server, url } = await startServer({ pool, tcl: tcl.cloud, locks: locks.handlers });
    servers.push(server);

    const cookie = agentCookie();
    // cf-connecting-ip trusted because the request transited CF (Traefik appended
    // a Cloudflare edge IP as the rightmost X-Forwarded-For hop).
    const resp = await control(
      url,
      { Cookie: cookie, "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "9.9.9.9, 162.158.1.1" },
      "set_power",
      1,
    );

    expect(resp.status).toBe(200);
    expect(locks.cleared).toEqual(["DHihohFAAAE"]);
    expect(locks.notified).toEqual([{ deviceId: "DHihohFAAAE", authKind: "agent", ip: "9.9.9.9" }]);
  });

  it("does not push when the AC was not manual-off locked", async () => {
    const tcl = createTclMock();
    const locks = createLockHandlers();
    const { server, url } = await startServer({ tcl: tcl.cloud, locks: locks.handlers });
    servers.push(server);

    await control(url, { Cookie: loginCookie() }, "set_power", 1);

    expect(locks.notified).toEqual([]);
  });

  it("does not push on a power-OFF (that records the lock, it does not release one)", async () => {
    const tcl = createTclMock();
    const locks = createLockHandlers();
    const { server, url } = await startServer({ tcl: tcl.cloud, locks: locks.handlers });
    servers.push(server);

    await control(url, { Cookie: loginCookie() }, "set_power", 0);

    expect(locks.notified).toEqual([]);
    expect(locks.locked.has("DHihohFAAAE")).toBe(true);
  });

  it("pushes once for a burst of turn-ons — only the call that released the lock notifies", async () => {
    const tcl = createTclMock();
    const locks = createLockHandlers(["DHihohFAAAE"]);
    const { server, url } = await startServer({ tcl: tcl.cloud, locks: locks.handlers });
    servers.push(server);

    const cookie = loginCookie();
    await Promise.all([
      control(url, { Cookie: cookie }, "set_power", 1),
      control(url, { Cookie: cookie }, "set_power", 1),
      control(url, { Cookie: cookie }, "set_power", 1),
    ]);

    expect(locks.notified).toHaveLength(1);
  });

  it("tags bearer-only requests as agent when no auth secret is configured", async () => {
    const pool = createRecordingPool();
    const tcl = createTclMock();
    const { server, url } = await startServer({
      pool,
      tcl: tcl.cloud,
      config: { ...TEST_CONFIG, authSecret: "" },
    });
    servers.push(server);

    const resp = await control(url, { Authorization: "Bearer hermes-secret" }, "set_power", 1);

    expect(resp.status).toBe(200);
    expect((pool.audits()[0].params as string[])[3]).toBe("agent");
  });

  it("prefers the cookie identity when a user cookie and the agent bearer are both sent", async () => {
    const pool = createRecordingPool();
    const tcl = createTclMock();
    const { server, url } = await startServer({ pool, tcl: tcl.cloud });
    servers.push(server);

    const cookie = loginCookie();
    await control(url, { Cookie: cookie, Authorization: "Bearer hermes-secret" }, "set_power", 1);

    expect((pool.audits()[0].params as string[])[3]).toBe("user");
  });

  it("prunes the audit table at most once a day, not on every control", async () => {
    const pool = createRecordingPool();
    const tcl = createTclMock();
    const { server, url } = await startServer({ pool, tcl: tcl.cloud });
    servers.push(server);

    const cookie = loginCookie();
    await control(url, { Cookie: cookie }, "set_power", 1);
    await control(url, { Cookie: cookie }, "set_temperature", 24);

    const prunes = pool.queries.filter((q) => q.sql.includes("DELETE FROM ac_control_audit"));
    expect(pool.audits()).toHaveLength(2);
    expect(prunes).toHaveLength(1);
    expect(prunes[0].params).toEqual(["30"]);
  });

  it("ignores a client-supplied X-Forwarded-For and a non-Cloudflare cf-connecting-ip", async () => {
    const pool = createRecordingPool();
    const tcl = createTclMock();
    const { server, url } = await startServer({ pool, tcl: tcl.cloud });
    servers.push(server);

    // No Cloudflare hop → both the client-supplied XFF and a forged cf-connecting-ip
    // are untrusted; the audit records the real socket peer, not the attacker's value.
    await control(
      url,
      { Cookie: loginCookie(), "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "9.9.9.9" },
      "set_power",
      1,
    );

    const ip = (pool.audits()[0].params as string[])[4];
    expect(ip).not.toBe("1.2.3.4");
    expect(ip).not.toBe("9.9.9.9");
  });
});
