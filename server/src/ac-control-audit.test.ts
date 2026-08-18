import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { acTimers, createRouter, type AcManualOffLockHandlers } from "./routes.js";
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

function createTclMock(validation: { ok: true } | { ok: false; status: 400 | 409 | 404; error: string } = { ok: true }) {
  const sent: Array<{ deviceId: string; command: string; value: unknown }> = [];
  const profiles: Array<{ deviceId: string; action: Record<string, unknown> }> = [];
  const knownIds = new Set(["DHihohFAAAE", "CA5IMhFAAAE", "Cy3aihFAAAE", "DlXqDBFAAAE"]);
  return {
    sent,
    profiles,
    cloud: {
      isReady: () => true,
      getDevices: () => [{ id: "DHihohFAAAE", name: "Najat" }],
      ensureDeviceCachePopulated: async () => undefined,
      sanitizeAcAction: (deviceId: string, action: Record<string, unknown>) => knownIds.has(deviceId) ? action : null,
      executeAcAction: async (deviceId: string, action: Record<string, unknown>) => {
        profiles.push({ deviceId, action });
      },
      executeAcActionVerified: async (deviceId: string, action: Record<string, unknown>) => {
        profiles.push({ deviceId, action });
        return "applied" as const;
      },
      validateControlLive: async () => validation,
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
  leveling?: Parameters<typeof createRouter>[9];
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
    options.leveling,
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
  acTimers.clear();
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

function control(url: string, headers: Record<string, string>, command: string, value: unknown, deviceId = "DHihohFAAAE") {
  return fetch(`${url}/api/ac/devices/${deviceId}/control`, {
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

  it("claims the release before the send, so the shadow echo can't steal it (2026-08-05)", async () => {
    const tcl = createTclMock();
    const locks = createLockHandlers(["DHihohFAAAE"]);
    // The real send runs restoreLastState, whose ~1s timer lets the TCL shadow
    // read ON before this handler returns — the device poll's observed-ON
    // reconcile then wins the atomic release and the actor-carrying push is
    // lost (live 00:42:34: "lock cleared" 455ms BEFORE "Restored last state").
    const send = tcl.cloud.sendControlVerified;
    tcl.cloud.sendControlVerified = async (deviceId: string, command: string, value: unknown) => {
      if (command === "set_power" && value === 1) await locks.handlers.clear(deviceId);
      await send(deviceId, command, value);
    };
    const { server, url } = await startServer({ tcl: tcl.cloud, locks: locks.handlers });
    servers.push(server);

    const resp = await control(
      url,
      { Cookie: agentCookie(), "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "9.9.9.9, 162.158.1.1" },
      "set_power",
      1,
    );

    expect(resp.status).toBe(200);
    expect(tcl.sent).toHaveLength(1);
    expect(locks.cleared).toEqual(["DHihohFAAAE"]); // only one caller can claim it
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

  it("notifies automation ownership immediately for a direct comfort control", async () => {
    const locks = createLockHandlers();
    const manual: Array<{ deviceId: string; command: string }> = [];
    locks.handlers.onUserProfileChange = (deviceId, command) => manual.push({ deviceId, command });
    const tcl = createTclMock();
    const { server, url } = await startServer({ tcl: tcl.cloud, locks: locks.handlers });
    servers.push(server);

    const resp = await control(url, { Cookie: loginCookie() }, "set_temperature", 22, "CA5IMhFAAAE");

    expect(resp.status).toBe(200);
    expect(manual).toEqual([{ deviceId: "CA5IMhFAAAE", command: "set_temperature" }]);
  });

  it("returns the device-aware capability status without sending or auditing", async () => {
    const pool = createRecordingPool();
    const tcl = createTclMock({ ok: false, status: 409, error: "Available in Heat mode" });
    const { server, url } = await startServer({ pool, tcl: tcl.cloud });
    servers.push(server);

    const resp = await control(url, { Cookie: loginCookie() }, "set_8c_heat", 1);

    expect(resp.status).toBe(409);
    expect(await resp.json()).toEqual({ error: "Available in Heat mode" });
    expect(tcl.sent).toEqual([]);
    expect(pool.audits()).toEqual([]);
  });

  it("records Self Clean manual-off protection before the cloud send", async () => {
    const events: string[] = [];
    const tcl = createTclMock();
    tcl.cloud.sendControlVerified = async () => { events.push("send"); };
    const locks = createLockHandlers();
    locks.handlers.record = async (deviceId) => {
      events.push("lock");
      locks.locked.add(deviceId);
    };
    const leveling = {
      getConfig: async () => ({}), updateConfig: async () => ({}), getStatus: () => ({}),
      onUserPowerOff: async () => { events.push("leveler-off"); },
      onUserPowerOn: async () => undefined,
      onUserGenLevel: async (_deviceId: string, level: number) => ({ reverted: false, level }),
    } as never;
    const { server, url } = await startServer({ tcl: tcl.cloud, locks: locks.handlers, leveling });
    servers.push(server);

    const resp = await control(url, { Cookie: loginCookie() }, "set_self_clean", 1);

    expect(resp.status).toBe(200);
    expect(events).toEqual(["lock", "leveler-off", "send"]);
    expect(locks.locked.has("DHihohFAAAE")).toBe(true);
  });

  it("does not call leveling handlers for the ineligible Guest AC", async () => {
    const tcl = createTclMock();
    const levelCalls: string[] = [];
    const notedGenLevels: Array<{ deviceId: string; level: number }> = [];
    const leveling = {
      getConfig: async () => ({}), updateConfig: async () => ({}), getStatus: () => ({}),
      onUserPowerOff: async () => { levelCalls.push("off"); },
      onUserPowerOn: async () => { levelCalls.push("on"); },
      noteUserGenLevel: (deviceId: string, level: number) => { notedGenLevels.push({ deviceId, level }); },
      onUserGenLevel: async (_deviceId: string, level: number) => { levelCalls.push("gen"); return { reverted: false, level }; },
    } as never;
    const { server, url } = await startServer({ tcl: tcl.cloud, leveling });
    servers.push(server);

    expect((await control(url, { Cookie: loginCookie() }, "set_generator_mode", 6, "DlXqDBFAAAE")).status).toBe(200);
    expect((await control(url, { Cookie: loginCookie() }, "set_power", 0, "DlXqDBFAAAE")).status).toBe(200);
    expect(levelCalls).toEqual([]);
    expect(notedGenLevels).toEqual([{ deviceId: "DlXqDBFAAAE", level: 6 }]);
  });

  it("applies a mode-dependent preset through one server profile operation", async () => {
    const tcl = createTclMock();
    const { server, url } = await startServer({ tcl: tcl.cloud });
    servers.push(server);

    const resp = await fetch(`${url}/api/ac/preset-apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: loginCookie() },
      body: JSON.stringify({
        deviceId: "DHihohFAAAE",
        slot: 2,
        presetData: { mode: 1, targetTemp: 23, fanSpeed: 5, eco: true, turbo: false, generatorMode: 3 },
      }),
    });

    expect(resp.status).toBe(200);
    expect(tcl.sent).toEqual([]);
    expect(tcl.profiles).toEqual([{
      deviceId: "DHihohFAAAE",
      action: { mode: 1, temperature: 23, fan_speed: 5, eco: 1, turbo: 0, generator_mode: 3 },
    }]);
  });

  it("rejects a timer for an unknown AC before storing it", async () => {
    const tcl = createTclMock();
    const { server, url } = await startServer({ tcl: tcl.cloud });
    servers.push(server);

    const resp = await fetch(`${url}/api/ac/timer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: loginCookie() },
      body: JSON.stringify({ deviceId: "missing", action: "on", minutes: 30, preset: { mode: 1, eco: 1 } }),
    });

    expect(resp.status).toBe(404);
    expect(acTimers.has("missing")).toBe(false);
    expect(tcl.profiles).toEqual([]);
  });

  it("rejects saving a preset for an unknown AC", async () => {
    const pool = createRecordingPool();
    const tcl = createTclMock();
    const { server, url } = await startServer({ pool, tcl: tcl.cloud });
    servers.push(server);

    const resp = await fetch(`${url}/api/ac/presets/missing/1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: loginCookie() },
      body: JSON.stringify({ presetData: { mode: 1, targetTemp: 24, fanSpeed: 3 } }),
    });

    expect(resp.status).toBe(404);
    expect(pool.queries.some((query) => query.sql.includes("INSERT INTO ac_presets"))).toBe(false);
  });

  it("does not persist an older preset request superseded by a newer one", async () => {
    const pool = createRecordingPool();
    const tcl = createTclMock();
    let call = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    (tcl.cloud as unknown as {
      executeAcActionVerified: (deviceId: string, action: Record<string, unknown>) => Promise<"applied" | "superseded">;
    }).executeAcActionVerified = async (deviceId, action) => {
      tcl.profiles.push({ deviceId, action });
      call += 1;
      if (call === 1) {
        firstStarted();
        await firstGate;
        return "superseded";
      }
      return "applied";
    };
    const { server, url } = await startServer({ pool, tcl: tcl.cloud });
    servers.push(server);
    const postPreset = (slot: number, mode: number) => fetch(`${url}/api/ac/preset-apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: loginCookie() },
      body: JSON.stringify({ deviceId: "DHihohFAAAE", slot, presetData: { mode, targetTemp: 23, fanSpeed: 3 } }),
    });

    const older = postPreset(1, 1);
    await firstStartedPromise;
    const newer = await postPreset(2, 2);
    releaseFirst();
    const olderResponse = await older;

    expect(newer.status).toBe(200);
    expect(olderResponse.status).toBe(409);
    const updates = pool.queries.filter((query) => query.sql.includes("UPDATE automations SET action_on"));
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0].params[0] as string)).toMatchObject({ mode: 2, _preset_slot: 2 });
  });
});
