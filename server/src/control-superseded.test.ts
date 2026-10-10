// Round 4 (Sol, 2026-09-27): a dashboard command that the cloud layer reports
// SUPERSEDED was never sent, so the control route must run none of its post-send
// ON bookkeeping. v2's onUserPowerOn would otherwise clear the shed (deleting the
// persistent shed row), revoke the cut share and arm ON bookkeeping for an ON
// that never happened, and the collector's shed guard (`isLevelerShed`, which
// reads exactly this shed set) would be lost. The route answers 409 with a
// message the dashboard shows.
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { acTimers, createRouter, type AcManualOffLockHandlers } from "./routes.js";
import type { Config } from "./config.js";
import { signToken } from "./auth.js";
import { LevelingControllerV2 } from "./leveling/controller.js";
import { TclCloud } from "./tcl-cloud.js";

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

const NAJAT = "DHihohFAAAE";

/** A v2 controller whose persisted shed table holds Najat. */
async function shedController() {
  const shedDeletes: unknown[] = [];
  /** Every write to the persistent shed table, in order. */
  const shedOps: string[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM ac_leveling_config") && sql.includes("id IN (1, 2)")) {
      return { rows: [{ id: 2, config: { controller: "v2", enabled: true, genLimitAmps: 15, marginAmps: 0.1 } }], rowCount: 1 };
    }
    if (sql.includes("SELECT") && sql.includes("FROM ac_leveling_shed")) {
      return { rows: [{ device_id: NAJAT, shed_at: new Date() }], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM ac_leveling_shed")) { shedDeletes.push(params[0]); shedOps.push("delete"); }
    if (sql.includes("INSERT INTO ac_leveling_shed")) shedOps.push("insert");
    return { rows: [], rowCount: 0 };
  });
  const controller = new LevelingControllerV2({ query } as never, {
    getTclCloud: () => null,
    broadcast: async () => undefined,
    setDevicePowerCache: () => undefined,
    isManualOffLocked: async () => false,
    onLevelerFanCommand: () => undefined,
  });
  await controller.ensureLoaded();
  return { controller, shedDeletes, shedOps };
}

function lockHandlers() {
  const locked = new Set<string>([NAJAT]);
  const handlers: AcManualOffLockHandlers = {
    record: async (deviceId) => { locked.add(deviceId); },
    clear: async (deviceId) => locked.delete(deviceId),
    isLocked: async (deviceId) => locked.has(deviceId),
    getLockedIds: async () => new Set(locked),
    reconcileDevices: async () => new Set(locked),
    notifyLockCleared: () => undefined,
  };
  return { handlers, locked };
}

function tclMock(outcome: "sent" | "superseded" | "superseded_by_user") {
  return {
    isReady: () => true,
    getDevices: () => [{ id: NAJAT, name: "Najat" }],
    ensureDeviceCachePopulated: async () => undefined,
    sanitizeAcAction: (_id: string, action: Record<string, unknown>) => action,
    validateControlLive: async () => ({ ok: true as const }),
    sendControlVerified: async () => outcome,
  };
}

const servers: Server[] = [];
afterEach(async () => {
  acTimers.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function start(tcl: Record<string, unknown>, locks: AcManualOffLockHandlers, leveling: unknown) {
  const app = express();
  app.use(express.json());
  app.use(createRouter(
    { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    TEST_CONFIG,
    undefined,
    (() => tcl) as never,
    undefined,
    undefined,
    undefined,
    undefined,
    locks,
    leveling as never,
  ));
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

function powerOn(url: string) {
  return fetch(`${url}/api/ac/devices/${NAJAT}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `auth=${signToken({ user: "admin", exp: Date.now() + 60_000 }, TEST_CONFIG.authSecret)}` },
    body: JSON.stringify({ command: "set_power", value: 1 }),
  });
}

describe("control route: a SUPERSEDED dashboard ON runs no post-send ON bookkeeping", () => {
  it("answers 409 with a message, never calls onUserPowerOn, and the shed row (the collector's shed guard) stays", async () => {
    const { controller, shedDeletes } = await shedController();
    const onUserPowerOn = vi.spyOn(controller, "onUserPowerOn");
    const locks = lockHandlers();
    const url = await start(tclMock("superseded"), locks.handlers, controller);

    const resp = await powerOn(url);

    expect(resp.status).toBe(409);
    const body = await resp.json() as { error?: string; message?: string };
    expect(body.error).toBe("superseded");
    expect(body.message).toMatch(/Not sent: Smart AC Leveling switched this AC off/);
    expect(onUserPowerOn).not.toHaveBeenCalled();
    expect(controller.isShed(NAJAT), "the collector's shed guard reads this set").toBe(true);
    expect(shedDeletes).toEqual([]);
    // Documented: the claim-before-send lock release stays released (the user's
    // intent is ON; the leveler restores a shed room with no lock when it fits).
    expect(locks.locked.has(NAJAT)).toBe(false);
  });

  it("a SENT ON still runs onUserPowerOn and answers 200 (unchanged)", async () => {
    const { controller } = await shedController();
    const onUserPowerOn = vi.spyOn(controller, "onUserPowerOn");
    const url = await start(tclMock("sent"), lockHandlers().handlers, controller);

    const resp = await powerOn(url);

    expect(resp.status).toBe(200);
    expect(onUserPowerOn).toHaveBeenCalledWith(NAJAT);
    expect(controller.isShed(NAJAT)).toBe(false);
  });
});

describe("control route: an ON SENT and then superseded during its saved-state restore (round 5, RULE B)", () => {
  it("real send path: ON published, restore held, leveler OFF, release: 409, no onUserPowerOn, shed intact, no restore publish", async () => {
    const { controller, shedDeletes } = await shedController();
    const onUserPowerOn = vi.spyOn(controller, "onUserPowerOn");
    // A real TclCloud send path with its network seams stubbed.
    const real = new TclCloud("user", "pass");
    const seam = real as unknown as {
      cachedDevices: unknown[]; ensureValidTokens: unknown; publishShadowUpdate: unknown; getThingShadow: unknown;
      controlVerifyDelay: unknown; ensureDeviceCachePopulated: unknown; restoreLastState: unknown;
      lastControlVerify: Promise<void> | null;
    };
    seam.cachedDevices = [{ id: NAJAT, name: "Najat", model: "TAC-24CHSA", capabilities: null }];
    const published: Array<Record<string, unknown>> = [];
    seam.publishShadowUpdate = vi.fn(async (_id: string, desired: Record<string, unknown>) => { published.push(desired); });
    seam.getThingShadow = vi.fn(async () => ({ reported: { powerSwitch: 0 }, reportedAt: null }));
    seam.ensureValidTokens = vi.fn(async () => undefined);
    seam.ensureDeviceCachePopulated = vi.fn(async () => undefined);
    seam.controlVerifyDelay = vi.fn(async () => undefined);
    let releaseRestore: () => void = () => undefined;
    let restoreStarted = false;
    seam.restoreLastState = vi.fn(() => {
      restoreStarted = true;
      return new Promise<void>((resolve) => { releaseRestore = resolve; });
    });
    const tcl = {
      ...tclMock("sent"),
      sendControlVerified: (id: string, command: string, value: unknown) => real.sendControlVerified(id, command, value),
    };
    const url = await start(tcl, lockHandlers().handlers, controller);

    const pending = powerOn(url);
    await vi.waitFor(() => expect(restoreStarted).toBe(true)); // the ON is published, the restore waits
    await real.executeAcAction(NAJAT, { power: 0 });          // the leveler sheds the room meanwhile
    releaseRestore();
    const resp = await pending;
    await seam.lastControlVerify;

    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error?: string }).error).toBe("superseded");
    expect(onUserPowerOn).not.toHaveBeenCalled();
    expect(controller.isShed(NAJAT)).toBe(true);
    expect(shedDeletes).toEqual([]);
    expect(published).toEqual([{ powerSwitch: 1 }, { powerSwitch: 0 }]);
  });
});

describe("control route: an ON superseded by the user's own next tap", () => {
  it("409 with the neutral message (never blames the leveler), and no onUserPowerOn", async () => {
    const { controller } = await shedController();
    const onUserPowerOn = vi.spyOn(controller, "onUserPowerOn");
    const url = await start(tclMock("superseded_by_user"), lockHandlers().handlers, controller);

    const resp = await powerOn(url);

    expect(resp.status).toBe(409);
    const body = await resp.json() as { error?: string; message?: string };
    expect(body.error).toBe("superseded");
    expect(body.message).toBe("Not sent: a newer command for this AC was sent at the same moment.");
    expect(onUserPowerOn).not.toHaveBeenCalled();
    expect(controller.isShed(NAJAT)).toBe(true);
  });
});

describe("control route: the caller-side handoff (round 6)", () => {
  it("a leveler OFF in the microtask gap after sendControlVerified resolves: the ON's bookkeeping never lands on top of the newer shed", async () => {
    const { controller, shedOps } = await shedController();
    const order: string[] = [];
    const realOn = controller.onUserPowerOn.bind(controller);
    vi.spyOn(controller, "onUserPowerOn").mockImplementation((id: string) => {
      order.push("onUserPowerOn");
      return realOn(id);
    });
    const real = new TclCloud("user", "pass");
    const seam = real as unknown as {
      cachedDevices: unknown[]; ensureValidTokens: unknown; publishShadowUpdate: unknown; getThingShadow: unknown;
      controlVerifyDelay: unknown; ensureDeviceCachePopulated: unknown; restoreLastState: unknown;
      lastControlVerify: Promise<void> | null;
    };
    seam.cachedDevices = [{ id: NAJAT, name: "Najat", model: "TAC-24CHSA", capabilities: null }];
    seam.publishShadowUpdate = vi.fn(async () => undefined);
    seam.getThingShadow = vi.fn(async () => ({ reported: { powerSwitch: 1 }, reportedAt: null }));
    seam.ensureValidTokens = vi.fn(async () => undefined);
    seam.ensureDeviceCachePopulated = vi.fn(async () => undefined);
    seam.controlVerifyDelay = vi.fn(async () => undefined);
    seam.restoreLastState = vi.fn(async () => undefined);
    const recordShed = (controller as unknown as { recordShed: (id: string, r: string) => Promise<void> }).recordShed.bind(controller);
    const tcl = {
      ...tclMock("sent"),
      // The gap: sendControlVerified's final check has passed and it has
      // resolved; before the route's continuation runs, the leveler sheds the
      // room (its OFF claims the generation and records the shed).
      sendControlVerified: async (id: string, command: string, value: unknown, onSent?: () => void) => {
        const outcome = await real.sendControlVerified(id, command, value, onSent);
        order.push("leveler OFF");
        await real.executeAcAction(NAJAT, { power: 0 });
        await recordShed(NAJAT, "over 15A on gen");
        return outcome;
      },
    };
    const url = await start(tcl, lockHandlers().handlers, controller);

    const resp = await powerOn(url);
    await seam.lastControlVerify;

    // The ON's own bookkeeping ran BEFORE the newer OFF (inside the final-check
    // tick), never after it: the newer shed stands, in memory and in the table.
    expect(order).toEqual(["onUserPowerOn", "leveler OFF"]);
    expect(controller.isShed(NAJAT), "the collector's shed guard reads this set").toBe(true);
    expect(shedOps[shedOps.length - 1], "the newer shed row is the last write").toBe("insert");
    expect(resp.status).toBe(200); // the ON was accepted and booked before the OFF existed
  });
});
