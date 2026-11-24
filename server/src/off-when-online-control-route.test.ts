// C1 (2026-10-10): a dashboard set_power is direct user power intent, so the
// control route drops a pending "turn off once back online" FIRST, synchronously
// at the request's entry (before validateControlLive and before its own
// manual-off lock work). L7 (Astra F9): only an arm OLDER than the request may
// be cancelled by it, so the entry cancel is the only one (sendControlVerified
// and executeAcActionVerified no longer disarm), the preset route cancels at its
// own entry too, and an arm accepted while an older request waits survives that
// request's resume. Arming in turn supersedes an older set_power still in
// flight.
//
// The first block drives the route with call-order fakes (control-superseded
// harness pattern). The second puts a REAL Collector and a REAL TclCloud behind
// the routes (only the TCL HTTP/AWS edges and the pg pool are faked, lock
// handlers wired as index.ts wires them). S3: those two routes answer success
// only once their entry cancel is durable.
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";

// Persistence stays off disk. `files` holds what was written (the arm file is
// written to a temp file, then renamed over it) and reads serve it (ENOENT
// otherwise), so a restarted TclCloud reads what the last one left. Writes of
// the arm file (and its temp file) can be held until `releaseArmWrites()`
// (`holdArmWrites`) or failed (`failArmWrites`).
const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  holdArmWrites: false,
  pendingArmWrites: [] as Array<() => void>,
  failArmWrites: null as Error | null,
}));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const isArmFile = (path: string) => path.startsWith("/app/data/ac-off-when-online.json");
  return {
    ...actual,
    readFile: vi.fn(async (path: string) => {
      const content = fsMock.files.get(String(path));
      if (content == null) throw enoent(String(path));
      return content;
    }),
    writeFile: vi.fn((path: string, data: string) => {
      const p = String(path);
      if (isArmFile(p) && fsMock.failArmWrites) return Promise.reject(fsMock.failArmWrites);
      if (isArmFile(p) && fsMock.holdArmWrites) {
        return new Promise<void>((resolve) => {
          fsMock.pendingArmWrites.push(() => {
            fsMock.files.set(p, String(data));
            resolve();
          });
        });
      }
      fsMock.files.set(p, String(data));
      return Promise.resolve();
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const data = fsMock.files.get(String(from));
      if (data == null) throw enoent(String(from));
      fsMock.files.delete(String(from));
      fsMock.files.set(String(to), data);
    }),
  };
});

function releaseArmWrites(): void {
  for (const complete of fsMock.pendingArmWrites.splice(0)) complete();
}

const logSpy = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./logger.js", () => ({ childLogger: () => logSpy }));

import { acTimers, createRouter, type AcManualOffLockHandlers } from "./routes.js";
import type { Config } from "./config.js";
import { signToken } from "./auth.js";
import { TclCloud, type AcDevice } from "./tcl-cloud.js";
import { Collector } from "./collector.js";
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
const OFF_FILE = "/app/data/ac-off-when-online.json";
const REASON = "cancelled by direct user power command";
/** A whole second, as AWS shadow metadata stamps are. */
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);

type Validation = { ok: true } | { ok: false; status: 400 | 409; error: string };

/** A cloud double that logs every call the route makes, in order. */
function fakeCloud(order: string[], validation: Validation = { ok: true }) {
  return {
    isReady: () => true,
    getDevices: () => [{ id: GUEST, name: "Guest" }],
    cancelOffWhenOnline: (deviceId: string, reason: string) => {
      order.push(`cancel ${deviceId}: ${reason}`);
    },
    validateControlLive: async () => {
      order.push("validate");
      return validation;
    },
    sendControlVerified: async (_id: string, command: string, value: unknown, onSent?: () => void) => {
      order.push(`send ${command}=${String(value)}`);
      onSent?.();
      return "sent" as const;
    },
  };
}

/** A lock store holding Guest's manual-off lock (the route's own dashboard lock work, unchanged). */
function lockStore(order: string[]) {
  const locked = new Set<string>([GUEST]);
  const handlers: AcManualOffLockHandlers = {
    record: async (deviceId, reason) => {
      order.push(`lock-record ${reason}`);
      locked.add(deviceId);
    },
    clear: async (deviceId) => {
      order.push("lock-clear");
      return locked.delete(deviceId);
    },
    isLocked: async (deviceId) => locked.has(deviceId),
    getLockedIds: async () => new Set(locked),
    reconcileDevices: async () => new Set(locked),
    notifyLockCleared: () => undefined,
  };
  return { handlers, locked };
}

const servers: Server[] = [];
/** The real fetch, kept for the test's own requests while the TCL edges are stubbed. */
const realFetch = globalThis.fetch;

beforeEach(() => {
  logSpy.info.mockClear();
  logSpy.warn.mockClear();
  logSpy.error.mockClear();
  fsMock.files.clear();
  fsMock.holdArmWrites = false;
  fsMock.pendingArmWrites.length = 0;
  fsMock.failArmWrites = null;
});

afterEach(async () => {
  acTimers.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function start(tcl: unknown, locks: AcManualOffLockHandlers) {
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
    undefined,
  ));
  const server = await listenOnFetchSafePort(app);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

function authed(url: string, path: string, body: unknown) {
  return realFetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `auth=${signToken({ user: "admin", exp: Date.now() + 60_000 }, TEST_CONFIG.authSecret)}`,
    },
    body: JSON.stringify(body),
  });
}

const control = (url: string, command: string, value: unknown) =>
  authed(url, `/api/ac/devices/${GUEST}/control`, { command, value });
const armRoute = (url: string, enabled: boolean) =>
  authed(url, `/api/ac/devices/${GUEST}/off-when-online`, { enabled });
const presetApply = (url: string, presetData: Record<string, unknown>) =>
  authed(url, "/api/ac/preset-apply", { deviceId: GUEST, slot: 1, presetData });

describe("control route: a set_power disarms off-when-online first, at the request's entry", () => {
  it("set_power=1: the disarm comes before validateControlLive and before the manual-off lock release", async () => {
    const order: string[] = [];
    const url = await start(fakeCloud(order), lockStore(order).handlers);

    const resp = await control(url, "set_power", 1);

    expect(resp.status).toBe(200);
    expect(order).toEqual([`cancel ${GUEST}: ${REASON}`, "validate", "lock-clear", "send set_power=1"]);
  });

  it("set_power=0 disarms too, before validation and before the dashboard's own lock record", async () => {
    const order: string[] = [];
    const url = await start(fakeCloud(order), lockStore(order).handlers);

    const resp = await control(url, "set_power", 0);

    expect(resp.status).toBe(200);
    expect(order).toEqual([`cancel ${GUEST}: ${REASON}`, "validate", "lock-record ui", "send set_power=0"]);
  });

  it("a non-power command does not disarm", async () => {
    const order: string[] = [];
    const url = await start(fakeCloud(order), lockStore(order).handlers);

    const resp = await control(url, "set_temperature", 24);

    expect(resp.status).toBe(200);
    expect(order).toEqual(["validate", "send set_temperature=24"]);
  });

  it("a set_power that then fails validation has still disarmed (the user expressed power intent)", async () => {
    const order: string[] = [];
    const cloud = fakeCloud(order, { ok: false, status: 409, error: "nope" });
    const url = await start(cloud, lockStore(order).handlers);

    const resp = await control(url, "set_power", 1);

    expect(resp.status).toBe(409);
    expect(order).toEqual([`cancel ${GUEST}: ${REASON}`, "validate"]);
  });
});

// ---------------------------------------------------------------------------
// A real Collector and a real TclCloud behind the routes.
// ---------------------------------------------------------------------------

interface Seam {
  tokenData: unknown;
  authData: unknown;
  awsCreds: unknown;
  signAwsRequest: () => Record<string, string>;
  ensureValidTokens: () => Promise<void>;
  publishShadowUpdate: (deviceId: string, desired: Record<string, unknown>) => Promise<void>;
  controlVerifyDelay: () => Promise<void>;
  cachedDevices: AcDevice[];
  lastState: Record<string, Record<string, unknown>>;
  fetchDevices: () => Promise<AcDevice[]>;
}

/** A Guest (TAC-24CHSA) shadow whose every field was last reported at `reportedAtMs`. */
function shadowDoc(power: 0 | 1, reportedAtMs: number): Record<string, unknown> {
  const reported: Record<string, number> = {
    powerSwitch: power,
    workMode: 1,
    targetTemperature: 24,
    currentTemperature: 27,
    windSpeed7Gear: 3,
    generatorMode: 0,
    autoGeneratorMode: 0,
    beepSwitch: 0,
  };
  const stamp = { timestamp: reportedAtMs / 1000 };
  return {
    state: { reported },
    metadata: { reported: Object.fromEntries(Object.keys(reported).map((key) => [key, stamp])) },
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  if (!condition()) throw new Error("condition not reached");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `until` on the (unfaked) timer clock: for a condition an HTTP round trip must reach. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await sleep(5);
  if (!condition()) throw new Error("condition not reached");
}

/** A held gate: `held` once something waits on it, `release()` lets it through. */
interface Gate {
  held: boolean;
  release: () => void;
}

/**
 * A real Collector and TclCloud. The Guest unit dropped offline ON an hour ago
 * (`online: false`, the default) or is online (`online: true`).
 */
async function realCollector(options: { online?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const events: string[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO ac_manual_off_locks")) events.push(`lock-insert ${String(params[1])}`);
      return { rows: [], rowCount: 0 };
    }),
  };
  const init = vi.spyOn(TclCloud.prototype, "init").mockResolvedValue(undefined);
  const collector = new Collector(pool as never, { ...TEST_CONFIG, tclUsername: "user", tclPassword: "pass" });
  try {
    await (collector as never as { initTclCloud: () => Promise<void> }).initTclCloud();
  } finally {
    init.mockRestore();
  }
  const tcl = collector.tclCloud!;
  const seam = tcl as unknown as Seam;
  const published: Array<Record<string, unknown>> = [];
  let doc = shadowDoc(1, T0 - 3_600_000); // the stale shadow of a unit that dropped offline ON
  let deviceListGate: Gate | null = null;

  seam.tokenData = { saasToken: "t", cognitoToken: "c", cognitoId: "i", mqttEndpoint: "m" };
  seam.authData = { token: "a", refreshToken: "r", username: "u", countryAbbr: "IQ" };
  seam.awsCreds = { accessKeyId: "k", secretKey: "s", sessionToken: "x", expiration: T0 + 3_600_000, region: "eu-central-1" };
  seam.signAwsRequest = () => ({});
  seam.ensureValidTokens = vi.fn(async () => undefined);
  seam.publishShadowUpdate = vi.fn(async (_deviceId: string, desired: Record<string, unknown>) => {
    published.push(desired);
  });
  seam.controlVerifyDelay = () => new Promise<void>(() => undefined); // park the user's verifier
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("user_groups/get")) {
      const gate = deviceListGate;
      if (gate) {
        deviceListGate = null;
        await new Promise<void>((resolve) => {
          gate.held = true;
          gate.release = resolve;
        });
      }
      return new Response(JSON.stringify({
        code: 0,
        data: [{ devices: [{ deviceId: GUEST, nickName: "guest", isOnline: options.online ? "1" : "0" }] }],
      }));
    }
    return new Response(JSON.stringify(doc));
  }));

  seam.cachedDevices = await seam.fetchDevices(); // nothing armed yet
  seam.lastState = {}; // no saved-state restore: the publish list holds only the commands
  published.length = 0;

  /** The lock handlers exactly as index.ts wires them. */
  const locks: AcManualOffLockHandlers = {
    record: (deviceId, reason) => collector.recordAcManualOff(deviceId, reason),
    clear: (deviceId) => collector.clearAcManualOff(deviceId),
    isLocked: (deviceId) => collector.isAcManualOffLocked(deviceId),
    getLockedIds: (deviceIds) => collector.getAcManualOffLockedIds(deviceIds),
    reconcileDevices: (devices) => collector.reconcileAcManualOffLocks(devices),
    notifyLockCleared: (deviceId, authKind, ip) => collector.notifyAcLockCleared(deviceId, authKind, ip),
  };

  return {
    collector,
    tcl,
    seam,
    events,
    published,
    locks,
    /** The unit's newest report, `secFromT0` seconds after T0. */
    report(power: 0 | 1, secFromT0: number): void {
      doc = shadowDoc(power, T0 + secFromT0 * 1000);
    },
    at(msFromT0: number): void {
      vi.setSystemTime(T0 + msFromT0);
    },
    /** The collector's dedicated off-when-online loop step. */
    async step(): Promise<void> {
      await (collector as never as { checkOffWhenOnline: () => Promise<void> }).checkOffWhenOnline();
    },
    /** Park the next token wait until the gate is released. */
    holdNextTokenWait(): Gate {
      const gate: Gate = { held: false, release: () => undefined };
      let used = false;
      seam.ensureValidTokens = vi.fn(() => {
        if (used) return Promise.resolve();
        used = true;
        return new Promise<void>((resolve) => {
          gate.held = true;
          gate.release = resolve;
        });
      });
      return gate;
    },
    /** Park the next device-list request (user_groups/get) until the gate is released. */
    holdNextDeviceList(): Gate {
      const gate: Gate = { held: false, release: () => undefined };
      deviceListGate = gate;
      return gate;
    },
  };
}

describe("routes with a real Collector and TclCloud", () => {
  it("the user's ON beats the armed OFF: cancelled at the route's entry, the OFF waiting on its token is never published", async () => {
    const h = await realCollector({ online: true });
    void h.tcl.setOffWhenOnline(GUEST, true); // armedAt = T0
    h.report(1, 5); // the unit is back and reporting ON
    h.at(6_000);
    await h.tcl.fetchDevicesLive(); // a fresh snapshot, so the only token wait left is the OFF's own
    const gate = h.holdNextTokenWait();
    const stepping = h.step();
    await until(() => gate.held);

    const url = await start(h.tcl, h.locks);
    const resp = await control(url, "set_power", 1);
    gate.release();
    await stepping;

    expect(resp.status).toBe(200);
    expect(h.published).toEqual([{ powerSwitch: 1 }]);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(logSpy.info).toHaveBeenCalledWith(expect.stringContaining(`${GUEST} disarmed: ${REASON}`));
    expect(h.events).toEqual([]); // and no lock record anywhere on the feature's side
  });

  it("L7: an older control request suspended in its validation while a newer arm is accepted: the arm survives the request's resume", async () => {
    const h = await realCollector();
    const url = await start(h.tcl, h.locks);
    const gate = h.holdNextTokenWait(); // inside validateControlLive's live re-read

    const responding = control(url, "set_power", 1);
    await until(() => gate.held);
    const armed = await armRoute(url, true);
    expect(armed.status).toBe(200);
    expect(await armed.json()).toEqual({ ok: true, offWhenOnline: true });
    gate.release();
    const resp = await responding;

    expect(resp.status).toBe(200);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);
    expect(logSpy.info).not.toHaveBeenCalledWith(expect.stringContaining("disarmed"));
  });

  it("L7: an older preset suspended in its device-cache fill while a newer arm is accepted: the arm survives the preset", async () => {
    const h = await realCollector();
    h.seam.controlVerifyDelay = async () => undefined; // let the preset's verify read run at once
    // Refresh the previously seen Guest. The arm route can use that cached
    // identity while the preset waits for the single in-flight list.
    const gate = h.holdNextDeviceList();
    vi.spyOn(h.tcl, "ensureDeviceCachePopulated").mockImplementationOnce(async () => {
      await h.tcl.fetchDevicesLive();
    });
    const url = await start(h.tcl, h.locks);
    const responding = presetApply(url, { mode: 1 });
    await until(() => gate.held);
    const armed = await armRoute(url, true);
    expect(armed.status).toBe(200);
    gate.release();
    const resp = await responding;

    expect(resp.status).toBe(200);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);
  });

  it("a preset cancels an arm made before it, at the preset route's entry, loudly", async () => {
    const h = await realCollector();
    h.seam.controlVerifyDelay = async () => undefined;
    void h.tcl.setOffWhenOnline(GUEST, true);
    const url = await start(h.tcl, h.locks);

    const resp = await presetApply(url, { mode: 1 });

    expect(resp.status).toBe(200);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(logSpy.info).toHaveBeenCalledWith(expect.stringContaining(`${GUEST} disarmed: cancelled by verified preset`));
  });

  it("L7: arming supersedes an older dashboard ON still waiting to publish: the ON is answered 409 and never sent", async () => {
    const h = await realCollector();
    const url = await start(h.tcl, h.locks);
    let tokenWaits = 0;
    const gate: Gate = { held: false, release: () => undefined };
    h.seam.ensureValidTokens = vi.fn(() => {
      tokenWaits += 1;
      if (tokenWaits !== 2) return Promise.resolve(); // the 1st is validateControlLive's, the 2nd the send's
      return new Promise<void>((resolve) => {
        gate.held = true;
        gate.release = resolve;
      });
    });

    const responding = control(url, "set_power", 1);
    await until(() => gate.held);
    const armed = await armRoute(url, true);
    expect(armed.status).toBe(200);
    gate.release();
    const resp = await responding;

    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { message?: string }).message).toMatch(/newer command/);
    expect(h.published).toEqual([]);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);
  });

  it("a set_power the cloud refuses (400) still disarms the arm, loudly", async () => {
    const h = await realCollector();
    void h.tcl.setOffWhenOnline(GUEST, true);
    const url = await start(h.tcl, h.locks);

    const resp = await control(url, "set_power", 5);

    expect(resp.status).toBe(400);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(logSpy.info).toHaveBeenCalledWith(expect.stringContaining(`${GUEST} disarmed: ${REASON}`));
    expect(h.published).toEqual([]);
  });
});

describe("S3: a success answer never comes before a durable entry cancel", () => {
  /** The `/control` set_power=1 and the verified preset: both cancel an arm made before them at their entry. */
  const routes = [
    { name: "control set_power", send: (url: string) => control(url, "set_power", 1) },
    { name: "verified preset", send: (url: string) => presetApply(url, { mode: 1 }) },
  ];

  it.each(routes)("$name: with the cancel's arm-file write held, the route does not answer until it completes", async ({ send }) => {
    const h = await realCollector();
    h.seam.controlVerifyDelay = async () => undefined; // let a preset's verify read run at once
    await h.tcl.setOffWhenOnline(GUEST, true); // armed, and saved
    const url = await start(h.tcl, h.locks);
    fsMock.holdArmWrites = true;

    let answered = false;
    const responding = send(url).then((resp) => {
      answered = true;
      return resp;
    });
    await waitFor(() => fsMock.pendingArmWrites.length > 0 && h.published.length > 0);
    await sleep(50);
    expect(answered).toBe(false); // the user's command went out; the answer waits for the cancel's write
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);

    releaseArmWrites();
    const resp = await responding;
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok?: boolean; warning?: string };
    expect(body.ok).toBe(true);
    expect(body.warning).toBeUndefined();
    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({});
  });

  it.each(routes)("$name: a cancel that could not be saved still answers 200 (the command succeeded) with a clear warning, logged at error level", async ({ send }) => {
    const h = await realCollector();
    h.seam.controlVerifyDelay = async () => undefined;
    await h.tcl.setOffWhenOnline(GUEST, true);
    const url = await start(h.tcl, h.locks);
    fsMock.failArmWrites = Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });

    const resp = await send(url);

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok?: boolean; warning?: string };
    expect(body.ok).toBe(true);
    expect(body.warning).toMatch(/could not be saved/);
    expect(body.warning).toMatch(/restart/);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false); // the cancel holds in memory
    expect(logSpy.error).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`\\[routes\\].*${GUEST}.*EROFS`)));
  });

  it("with nothing armed, the control route answers as before (no warning, nothing to wait for)", async () => {
    const h = await realCollector();
    const url = await start(h.tcl, h.locks);
    fsMock.holdArmWrites = true; // nothing may be waiting on the arm file

    const resp = await control(url, "set_power", 1);

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    expect(fsMock.pendingArmWrites).toEqual([]);
  });

  it("a restart from the arm file as it stood at the acknowledgement cannot bring the cancelled arm back", async () => {
    const h = await realCollector();
    await h.tcl.setOffWhenOnline(GUEST, true);
    const url = await start(h.tcl, h.locks);
    fsMock.holdArmWrites = true; // a slow disk

    let retained: string | undefined;
    const responding = control(url, "set_power", 1).then((resp) => {
      retained = fsMock.files.get(OFF_FILE); // the server dies right after it answered
      return resp;
    });
    await waitFor(() => fsMock.pendingArmWrites.length > 0);
    await sleep(50);
    releaseArmWrites();
    expect((await responding).status).toBe(200);

    expect(await restartedArmed(retained)).toBe(false);
  });
});

/** A restart on the arm file `retained` (as the server left it): is Guest armed again? */
async function restartedArmed(retained: string | undefined): Promise<boolean> {
  fsMock.holdArmWrites = false;
  fsMock.failArmWrites = null;
  fsMock.files.clear();
  if (retained != null) fsMock.files.set(OFF_FILE, retained);
  const restarted = new TclCloud("user", "pass");
  await (restarted as unknown as { offWhenOnlineLoaded: Promise<void> }).offWhenOnlineLoaded;
  return restarted.isOffWhenOnlineArmed(GUEST);
}

describe("R2: a success answer waits until the arm file excludes the arm, whichever path removed it", () => {
  type Harness = Awaited<ReturnType<typeof realCollector>>;
  const routes = [
    {
      route: "control set_power",
      send: (url: string) => control(url, "set_power", 1),
      /** The request reached its success answer's wait: its own command went out. */
      reached: (h: Harness) => h.published.some((p) => p.powerSwitch === 1),
    },
    {
      route: "verified preset",
      send: (url: string) => presetApply(url, { mode: 1 }),
      reached: (h: Harness) => h.published.some((p) => p.workMode === 1),
    },
    {
      route: "off-when-online disarm",
      send: (url: string) => armRoute(url, false),
      reached: () => logSpy.info.mock.calls.some((call) => String(call[0]).includes(`off_when_online=0 → ${GUEST}`)),
    },
  ];
  const removals = [
    {
      removal: "an earlier cancel",
      remove: async (h: Harness) => {
        h.tcl.cancelOffWhenOnline(GUEST, "cancelled from the dashboard");
      },
    },
    {
      removal: "a fetch's terminal OFF",
      remove: async (h: Harness) => {
        h.report(0, 5); // the unit came back OFF, seen by a dashboard poll's fetch
        h.at(6_000);
        await h.tcl.fetchDevicesLive();
      },
    },
  ];
  const cases = routes.flatMap((route) => removals.map((removal) => ({ ...route, ...removal })));

  /** Armed and saved, then removed by `remove` while its write is held or fails. */
  async function armedThenRemoved(remove: (h: Harness) => Promise<void>, write: "held" | "failed") {
    const h = await realCollector();
    h.seam.controlVerifyDelay = async () => undefined; // let a preset's verify read run at once
    await h.tcl.setOffWhenOnline(GUEST, true); // armed, and saved
    const url = await start(h.tcl, h.locks);
    if (write === "held") {
      fsMock.holdArmWrites = true; // a slow disk
      await remove(h);
      await waitFor(() => fsMock.pendingArmWrites.length > 0); // the removal's write is under way
    } else {
      fsMock.failArmWrites = Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      await remove(h);
      await waitFor(() => logSpy.error.mock.calls.some((call) => String(call[0]).includes("Could not save the off-when-back-online arms")));
      fsMock.failArmWrites = null;
    }
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(Object.keys(JSON.parse(fsMock.files.get(OFF_FILE) ?? "{}"))).toEqual([GUEST]); // the file still holds it
    return { h, url };
  }

  /** Send, and record whether (and with what arm file) it answered. */
  function sendWatched(send: (url: string) => ReturnType<typeof control>, url: string) {
    const watch = { answered: false, retained: undefined as string | undefined };
    const responding = send(url).then((resp) => {
      watch.answered = true;
      watch.retained = fsMock.files.get(OFF_FILE); // the server dies right after it answered
      return resp;
    });
    return { watch, responding };
  }

  it.each(cases)("$route after $removal whose write is still pending: no answer until the removal is durable; a restart from the file at the answer keeps it cancelled", async ({ send, reached, remove }) => {
    const { h, url } = await armedThenRemoved(remove, "held");

    const { watch, responding } = sendWatched(send, url);
    await waitFor(() => reached(h));
    await sleep(50);
    expect(watch.answered).toBe(false);

    releaseArmWrites();
    const resp = await responding;
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { warning?: string }).warning).toBeUndefined();
    expect(JSON.parse(watch.retained ?? "null")).toEqual({});
    expect(await restartedArmed(watch.retained)).toBe(false);
  });

  it.each(cases)("$route after $removal whose write FAILED: the request writes again and answers only once that write completed", async ({ send, reached, remove }) => {
    const { h, url } = await armedThenRemoved(remove, "failed");
    fsMock.holdArmWrites = true;

    const { watch, responding } = sendWatched(send, url);
    await waitFor(() => reached(h));
    await sleep(50);
    expect(watch.answered).toBe(false);
    expect(fsMock.pendingArmWrites.length).toBeGreaterThan(0); // the retried write is under way

    releaseArmWrites();
    const resp = await responding;
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { warning?: string }).warning).toBeUndefined();
    expect(JSON.parse(watch.retained ?? "null")).toEqual({});
    expect(await restartedArmed(watch.retained)).toBe(false);
  });

  it.each(cases)("$route after $removal whose write FAILED, and the retry fails too: the answer says the cancel was not saved", async ({ route, send, remove }) => {
    const { url } = await armedThenRemoved(remove, "failed");
    fsMock.failArmWrites = Object.assign(new Error("EIO: i/o error again"), { code: "EIO" });
    logSpy.error.mockClear();

    const resp = await send(url);

    const body = (await resp.json()) as { ok?: boolean; warning?: string; error?: string };
    if (route === "off-when-online disarm") {
      expect(resp.status).toBe(500);
      expect(body.error).toMatch(/Cancelled, but it could not be saved/);
    } else {
      expect(resp.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.warning).toMatch(/could not be saved/);
      expect(logSpy.error).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`\\[routes\\].*${GUEST}.*again`)));
    }
    expect(Object.keys(JSON.parse(fsMock.files.get(OFF_FILE) ?? "{}"))).toEqual([GUEST]);
  });
});
