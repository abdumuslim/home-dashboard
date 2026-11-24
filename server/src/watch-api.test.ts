import express from "express";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWatchGate, watchSky, watchSun, airLevel } from "./watch-api.js";
import { createRouter } from "./routes.js";
import { Collector } from "./collector.js";
import { signToken } from "./auth.js";
import type { Config } from "./config.js";
import { TclCloud, type AcDevice } from "./tcl-cloud.js";
import { XiaomiCloud, type PurifierDevice } from "./xiaomi-cloud.js";
import { listenOnFetchSafePort } from "./test-http.js";

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./logger.js", () => ({ childLogger: () => logs }));
const secret = () => randomBytes(32).toString("base64url");
const config = { adminUser: "test", authSecret: secret(), hermesApiToken: secret(), watchApiToken: secret() } as Config;
const mom = "DHihohFAAAE", guest = "DlXqDBFAAAE", miio = "357465941", miot = "317499063";
const servers: Server[] = [], collectors: Collector[] = [];
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const watch = bearer(config.watchApiToken!), hermes = bearer(config.hermesApiToken);
const cookie = (agent = false) => ({ cookie: "auth=" + signToken({ user: "test", agent }, config.authSecret) });

afterEach(async () => {
  for (const c of collectors.splice(0)) c.stop();
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => {
    s.close(() => resolve());
    s.closeAllConnections();
  })));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function harness(cfg = config, genLevel?: () => Promise<unknown>) {
  const weather: Record<string, unknown>[] = [], air: Record<string, unknown>[] = [];
  const presets = new Map<number, Record<string, unknown>>();
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    let rows: Record<string, unknown>[] = [];
    if (sql.includes("FROM weather_readings")) rows = weather;
    if (sql.includes("FROM air_readings")) rows = air;
    if (sql.includes("FROM ac_presets") && args[0] === mom) {
      rows = Array.from(presets, ([slot, data]) => ({ slot, data })).filter(r => args.length === 1 || r.slot === args[1]);
    }
    return { rows, rowCount: rows.length };
  });
  const devices: AcDevice[] = [];
  const purifiers: PurifierDevice[] = [];
  const tcl = {
    isReady: () => true, getDevices: () => devices,
    getDevicesNoOlderThan: vi.fn(async () => devices), fetchDevicesLive: vi.fn(async () => devices),
    ensureDeviceCachePopulated: vi.fn(), cancelOffWhenOnline: vi.fn(),
    claimPresetIntent: () => () => true,
    validateControlLive: vi.fn(async () => ({ ok: true })), sendControlVerified: vi.fn(async () => "sent"),
    sanitizeAcAction: vi.fn((_id: string, action: object) => ({ ...action })),
    executeAcActionVerified: vi.fn(async () => "applied"),
  };
  const xiaomi = { isReady: () => true, getDevices: () => purifiers, getRegion: () => "sg",
    getAuthStatus: () => ({ status: "authenticated" }),
    fetchDevicesLive: vi.fn(async () => purifiers), sendControlCommand: vi.fn() };
  const pool = { query } as never;
  const collector = new Collector(pool, cfg);
  collectors.push(collector);
  collector.tclCloud = tcl as never;
  collector.xiaomiCloud = xiaomi as never;
  const locks = {
    clear: vi.fn(async () => true), record: vi.fn(), isLocked: vi.fn(), getLockedIds: vi.fn(),
    reconcileDevices: vi.fn(), notifyLockCleared: collector.notifyAcLockCleared.bind(collector),
  };
  const push = vi.spyOn(collector as unknown as { broadcastPush(payload: object): Promise<void> }, "broadcastPush").mockResolvedValue(undefined);
  const changed = vi.fn();
  const api = createRouter(pool, cfg, () => xiaomi as never, () => tcl as never, undefined,
    () => ({ cached: true }) as never, undefined, changed, locks, genLevel ? { onUserGenLevel: genLevel } as never : undefined);
  const app = express(), downstream = vi.fn();
  app.use(createWatchGate(cfg, pool, collector, api.controls));
  app.use((_req, _res, next) => { downstream(); next(); });
  app.use(express.json(), api);
  app.get(["/diag", "/static/icon.svg", "/{*splat}"], (_req, res) => res.send("site"));
  const server = await listenOnFetchSafePort(app);
  servers.push(server);
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const request = (path: string, method = "GET", headers: Record<string, string> = watch, body?: unknown) =>
    fetch(base + path, { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const audits = () => query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO ac_control_audit")).map(([, args]) => args);
  const writes = () => query.mock.calls.filter(([sql]) => sql.includes("UPDATE automations"));
  return { request, base, audits, writes, query, collector, weather, air, devices, purifiers, presets,
    tcl, xiaomi, locks, push, changed, downstream };
}

function device(id: string, ts: number) {
  return { id, lastSeenAt: ts, powerReportedAt: ts, isOnline: true, power: true, powerKnown: true, mode: 1,
    currentTemp: 26.5, targetTemp: 25, targetTempKnown: true, currentTempKnown: true, fanSpeed: 3, capabilities: { modes: [{ value: 1 }], fanSpeeds: [{ value: 3 }] } } as AcDevice;
}
function purifier(id: string): PurifierDevice {
  return { id, name: "purifier", model: id === miot ? "zhimi.airpurifier.vb2" : "zhimi.airpurifier.v7",
    isOnline: true, readingsAt: Date.now(), readingsStale: false, power: "on", mode: "auto", fan_level: 2, favorite_level: 7, aqi: 9 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("watch repair regressions", () => {
  it("shows the acting v2 tick's sample, then clears all power fields on rollback or expiry", async () => {
    const h = await harness();
    h.devices.push(device(guest, Date.now()));
    const query = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql, args) => {
      if (sql.includes("FROM ac_leveling_config")) return { rows: [
        { id: 1, config: { enabled: true, gridLimitAmps: 30 } }, { id: 2, config: { controller: "v2" } },
      ], rowCount: 2 };
      return query(sql, args);
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    await h.collector.acLeveler2.ensureLoaded();
    const at = Date.now(), sample = (amps: number) => h.collector.setLatestPower({
      ts: new Date().toISOString(), voltage: 220, current_1: amps, current_2: 0, power_1: amps * 220, power_2: 0,
    });
    sample(10);
    vi.setSystemTime(at + 4000);
    sample(14);
    await (h.collector as unknown as { runLevelingCheck(): Promise<void> }).runLevelingCheck();
    expect(h.collector.leveling()).toBe(h.collector.acLeveler2);
    const power = async () => (await (await h.request("/api/watch")).json()).power;
    const empty = { source: null, amps: null, limit: null, ts: null };
    expect(await power()).toEqual({ source: "grid", amps: 12, limit: 30, ts: at + 4000 });
    const flavor = vi.spyOn(h.collector.acLeveler2, "controllerFlavor").mockReturnValue("v1");
    expect(await power()).toEqual(empty);
    flavor.mockRestore();
    vi.setSystemTime(at + 19_001);
    expect(await power()).toEqual(empty);
  });

  it.each(["cache", "delivery", "generator bookkeeping"])("supersedes the older preset during %s", async stage => {
    const started = deferred<void>(), release = deferred<void>();
    const wait = async () => { started.resolve(); await release.promise; };
    const h = await harness(config, stage === "generator bookkeeping" ? wait : undefined);
    h.presets.set(1, { targetTemp: 23, generatorMode: 2 });
    if (stage === "cache") h.tcl.ensureDeviceCachePopulated.mockImplementationOnce(wait);
    if (stage === "delivery") h.tcl.executeAcActionVerified.mockImplementationOnce(async () => { await wait(); return "applied"; });
    const old = h.request(`/api/watch/ac/${mom}/preset`, "POST", watch, { slot: 1 });
    await started.promise;
    try {
      const newer = await h.request("/api/ac/preset-apply", "POST", hermes, { deviceId: mom, slot: 2, presetData: { targetTemp: 28 } });
      expect(newer.status).toBe(200);
    } finally { release.resolve(); }
    expect((await old).status).toBe(409);
    expect(h.tcl.executeAcActionVerified).toHaveBeenCalledTimes(stage === "cache" ? 1 : 2);
    expect(h.writes().map(([, args]) => JSON.parse(String(args?.[0]))._preset_slot)).toEqual([2]);
  });

  it.each(["/api/ac/devices/" + mom + "/control", "/api/devices/" + miot + "/control", "/api/ac/preset-apply"])(
    "preserves the legacy Express response to unparsed bodies on %s", async path => {
      const h = await harness();
      for (const body of [undefined, "unparsed text"]) {
        const r = await fetch(h.base + path, { method: "POST", headers: hermes, body });
        expect(r.status).toBe(500);
        expect(r.headers.get("content-type")).toContain("text/html");
      }
      expect(h.writes()).toHaveLength(0);
      expect(h.audits()).toHaveLength(0);
    });

  it("uses the dashboard clock across sunrise while preserving the weather sample time", async () => {
    const h = await harness(), ts = Date.parse("2026-06-21T01:55Z");
    h.weather.push({ ts: new Date(ts), solar_radiation: 0, humidity: 60 });
    const clock = vi.spyOn(Date, "now").mockReturnValue(ts);
    const weather = async () => (await (await h.request("/api/watch")).json()).weather;
    expect(await weather()).toMatchObject({ sky: "clear_night", isDay: false, ts });
    clock.mockReturnValue(Date.parse("2026-06-21T02:30Z"));
    expect(await weather()).toMatchObject({ sky: "cloudy", isDay: true, ts });
  });

  it("joins a held TCL guest restore across watch and collector and decodes known OFF without metadata", async () => {
    const h = await harness();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const tcl = new TclCloud("user", "pass");
    const restore = deferred<void>(), started = deferred<void>();
    const publish = vi.fn(async () => { started.resolve(); await restore.promise; });
    const rooms = [guest, mom, "CA5IMhFAAAE", "Cy3aihFAAAE"];
    const shadow = vi.fn(async (id: string) => ({
      reported: id === guest ? { powerSwitch: 1, autoGeneratorMode: 0 } : id === mom ? { powerSwitch: 0 } : {},
      reportedAt: Date.now() + 1000,
    }));
    Object.assign(tcl, { tokenData: {}, authData: {}, awsCreds: {}, ensureValidTokens: async () => {},
      lastState: { [guest]: { targetTemperature: 22 } }, getThingShadow: shadow, publishShadowUpdate: publish });
    h.collector.tclCloud = tcl;
    const list = vi.fn(async () => Response.json({ data: [{ devices: rooms.map(id => ({
      deviceId: id, nickName: id, identifiers: id === "CA5IMhFAAAE" ? [{ identifier: "powerSwitch", value: 0 }] : [],
    })) }] }));
    // Only provider HTTP is stubbed while the real restore is suspended.
    expect(tcl.preparePowerCycleRestore(guest)).toBe(true);
    vi.stubGlobal("fetch", list);
    let first: AcDevice[];
    try {
      const collectorFetch = tcl.fetchDevicesLive();
      await started.promise;
      h.collector.noteWatchRequest();
      await vi.advanceTimersByTimeAsync(15_000);
      restore.resolve();
      first = await collectorFetch;
      await vi.advanceTimersByTimeAsync(0);
    } finally { restore.resolve(); vi.unstubAllGlobals(); }
    expect.soft(list).toHaveBeenCalledTimes(1);
    expect.soft(shadow).toHaveBeenCalledTimes(4);
    expect.soft(publish).toHaveBeenCalledTimes(1);
    expect.soft(tcl.getDevices()).toBe(first);
    const snap = await (await h.request("/api/watch")).json();
    expect(snap.acs.map((a: { on: boolean | null }) => a.on)).toEqual([false, false, null, true]);
  });

  it("joins a collector list and live readers, stamping each purifier only when its properties land", async () => {
    const h = await harness();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const cloud = new XiaomiCloud("user", "pass", "sg");
    const list = deferred<PurifierDevice[]>(), slow = deferred<Partial<PurifierDevice>>();
    const identities = [miio, miot].map(id => {
      const { id: did, name, model, isOnline } = purifier(id);
      return { id: did, name, model, isOnline };
    });
    const fetchList = vi.fn(() => list.promise);
    const props = vi.fn((id: string) => id === miio ? Promise.resolve({ aqi: 8 }) : slow.promise);
    Object.assign(cloud, { authStatus: "authenticated", fetchPurifiersForRegion: fetchList, getDeviceProps: props });
    h.collector.xiaomiCloud = cloud;
    const collectorList = cloud.refreshDevices();
    h.collector.noteWatchRequest();
    await vi.advanceTimersByTimeAsync(15_000);
    const browser = cloud.fetchDevicesLive();
    await vi.advanceTimersByTimeAsync(1000);
    list.resolve(identities);
    await vi.advanceTimersByTimeAsync(0);
    const firstAt = Date.now();
    const snapshot = async () => (await (await h.request("/api/watch")).json()).purifiers;
    const partial = await snapshot();
    await vi.advanceTimersByTimeAsync(4000);
    const secondAt = Date.now();
    slow.resolve({ aqi: 14 });
    const [, devices] = await Promise.all([collectorList, browser]);
    expect.soft(fetchList).toHaveBeenCalledTimes(1);
    expect.soft(props).toHaveBeenCalledTimes(2);
    expect.soft(cloud.getDevices()).toBe(devices);
    expect.soft(partial[0]).toMatchObject({ pm25: 8, ts: firstAt });
    expect.soft(partial[1]).toMatchObject({ pm25: null, ts: null });
    expect.soft((await snapshot())[1]).toMatchObject({ pm25: 14, ts: secondAt });
    props.mockRejectedValue(new Error("unavailable"));
    await vi.advanceTimersByTimeAsync(1000);
    await cloud.fetchDevicesLive();
    const failed = await snapshot();
    expect(failed[0]).toMatchObject({ pm25: 8, ts: firstAt });
    expect(failed[1]).toMatchObject({ pm25: 14, ts: secondAt });
  });

  it("prefers today's list-only OFF to an older cached ON shadow", async () => {
    const h = await harness(), previous = device(mom, Date.now() - 30_000);
    h.devices.push(previous);
    expect((await (await h.request("/api/watch")).json()).acs[0].on).toBe(true);
    h.devices[0] = { ...previous, power: false, powerKnown: true, lastSeenAt: null, powerReportedAt: null };
    expect((await (await h.request("/api/watch")).json()).acs[0].on).toBe(false);
  });
});

describe("app-wide watch bearer", () => {
  it("refuses all other surfaces even beside full-access cookies, before parsing bodies or dispatching", async () => {
    const h = await harness();
    const attempts = [
      ["GET", "/api/health"], ["GET", "/api/forecast"], ["GET", "/api/prayer-times"], ["GET", "/diag"],
      ["GET", "/static/icon.svg"], ["GET", "/"], ["GET", "/some/spa"], ["GET", "/unknown"],
      ["POST", "/api/auth/logout"], ["POST", "/api/auth/login"], ["POST", "/api/agent/session"],
      ["GET", "/api/agent/snapshot"], ["POST", "/api/ac/preset-apply"], ["POST", "/api/power/ingest"],
      ["GET", "/API/watch"], ["GET", "/api/watch/"], ["HEAD", "/api/watch?x=1/rest"],
      ["HEAD", "/api/watch"], ["HEAD", `/api/watch/ac/${mom}/presets`],
      ["PUT", "/api/watch"], ["OPTIONS", "/api/watch"], ["DELETE", "/api/watch?method=GET"],
      ["POST", "/api/watch/ac/unknown/power"], ["POST", "/api/watch/ac/%2F/power"],
      ["POST", "/api/watch/ac/%E0%A4/power"], ["POST", `/api/watch/ac/${mom}/Power`],
      ["POST", `/api/watch/ac/${mom}/power/`], ["GET", `/api/watch/ac/${mom}/power`],
    ];
    for (const [method, path] of attempts) {
      for (const extra of [{}, cookie(), cookie(true)]) {
        const r = await h.request(path, method, { ...watch, ...extra, "X-HTTP-Method-Override": "POST" });
        expect(r.status, path).toBe(401);
        expect(r.headers.get("content-type")).toContain("application/json");
        expect(r.headers.get("cache-control")).toBe("no-store");
        expect(r.headers.has("set-cookie")).toBe(false);
        if (method !== "HEAD") expect(await r.json()).toEqual({ error: "Unauthorized" });
      }
    }
    expect(h.downstream).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.tcl.sendControlVerified).not.toHaveBeenCalled();
  });

  it("keeps public, cookie and Hermes access and reserves the watch namespace", async () => {
    const h = await harness();
    for (const headers of [{}, cookie(), cookie(true), hermes, bearer("invalid")]) {
      for (const path of ["/api/health", "/api/forecast", "/api/prayer-times", "/static/icon.svg", "/some/spa"]) {
        expect((await h.request(path, "GET", headers)).status).toBe(200);
      }
      for (const path of ["/api/watch", "/api/watch/", "/api/watch/missing?x=1"]) {
        const r = await h.request(path, "GET", headers);
        expect(r.status).toBe(401);
        expect(await r.json()).toEqual({ error: "Unauthorized" });
      }
    }
    for (const headers of [cookie(), cookie(true), hermes]) {
      expect(await (await h.request("/api/auth/me", "GET", headers)).json()).toEqual({ authenticated: true });
    }
    expect((await h.request("/api/agent/session", "POST", hermes)).headers.has("set-cookie")).toBe(true);
    const malformed = bearer("é".repeat(config.hermesApiToken.length));
    expect((await h.request("/api/agent/session", "POST", malformed)).status).toBe(401);
    expect((await h.request("/api/watch", "GET", malformed)).status).toBe(401);
  });

  it("disabled, rotated and colliding keys cannot open a session or the watch API", async () => {
    for (const cfg of [{ ...config, watchApiToken: "" }, { ...config, watchApiToken: secret() }]) {
      const h = await harness(cfg);
      expect((await h.request("/api/watch")).status).toBe(401);
      expect((await h.request("/api/agent/session", "POST")).headers.has("set-cookie")).toBe(false);
      expect((await h.request("/api/agent/session", "POST", hermes)).status).toBe(200);
      if (cfg.watchApiToken) expect((await h.request("/api/watch", "GET", bearer(cfg.watchApiToken))).status).toBe(503);
    }
    const h = await harness({ ...config, watchApiToken: config.hermesApiToken });
    for (const path of ["/api/agent/session", "/api/watch", "/api/health"]) {
      const r = await h.request(path, path.endsWith("session") ? "POST" : "GET", { ...hermes, ...cookie() });
      expect(r.status).toBe(401);
      expect(r.headers.has("set-cookie")).toBe(false);
    }
    expect(logs.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(Object.values(logs).map(l => l.mock.calls));
    expect([config.hermesApiToken, config.watchApiToken!].some(key => logged.includes(key))).toBe(false);
  });
  it("recognizes the scoped key when dashboard sessions are disabled", async () => {
    const h = await harness({ ...config, authSecret: "" });
    expect((await h.request("/api/watch")).status).toBe(503);
    expect((await h.request("/api/health", "GET", { ...watch, ...cookie() })).status).toBe(401);
  });
});

describe("watch device controls through the dashboard handlers", () => {
  it("rejects malformed power before changing an arm, then attributes the lock, loud release and supersession", async () => {
    const h = await harness(), path = `/api/watch/ac/${mom}/power`;
    for (const on of [1, 0, null, "true", undefined, {}]) expect((await h.request(path, "POST", watch, { on })).status).toBe(400);
    expect(h.tcl.cancelOffWhenOnline).not.toHaveBeenCalled();
    expect(h.tcl.validateControlLive).not.toHaveBeenCalled();
    expect(h.audits()).toHaveLength(0);
    const headers = { ...watch, ...cookie(true) };
    const off = await h.request(path.replace("DHi", "%44Hi") + "?from=clock", "POST", headers, { on: false });
    expect(off.status).toBe(200);
    expect(off.headers.has("set-cookie")).toBe(false);
    expect(h.locks.record).toHaveBeenCalledWith(mom, "ui");
    h.tcl.sendControlVerified.mockResolvedValue("superseded");
    expect((await h.request(path, "POST", headers, { on: true })).status).toBe(409);
    expect(h.push).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ body: expect.stringContaining("the watch") }));
    expect(h.push.mock.invocationCallOrder[0]).toBeLessThan(h.tcl.sendControlVerified.mock.invocationCallOrder[1]);
    expect(h.audits().map(a => a?.slice(0, 4))).toEqual([[mom, "set_power", "0", "watch"], [mom, "set_power", "1", "watch"]]);
  });

  it("loads only the saved slot and syncs enabled rules only after successful delivery", async () => {
    const h = await harness(), path = `/api/watch/ac/${mom}/preset`;
    // A previous status marked the room opted out; the acting controller now
    // manages it. Never let that stale bit publish the saved unrestricted cap.
    vi.spyOn(h.collector.acLeveler, "isEnabled").mockReturnValue(true);
    const status = h.collector.acLeveler.getStatus();
    vi.spyOn(h.collector.acLeveler, "getStatus").mockReturnValue({
      ...status, acs: [{ deviceId: mom, managed: false } as never],
    });
    h.presets.set(4, { mode: 1, targetTemp: 23, generatorMode: 0 });
    const list = await h.request(path + "s");
    expect(await list.json()).toEqual({ presets: [{ slot: 4, on: true, mode: "cool", setC: 23 }] });
    for (const body of [{ slot: "4" }, { slot: 11 }, { slot: 0 }, { slot: 4, presetData: { targetTemp: 31 } }]) {
      expect((await h.request(path, "POST", watch, body)).status).toBe(400);
    }
    expect((await h.request(path, "POST", watch, { slot: 5 })).status).toBe(404);
    expect(h.tcl.executeAcActionVerified).not.toHaveBeenCalled();
    h.tcl.executeAcActionVerified.mockResolvedValueOnce("superseded");
    expect((await h.request(path, "POST", watch, { slot: 4 })).status).toBe(409);
    expect(h.writes()).toHaveLength(0);
    expect(h.changed).not.toHaveBeenCalled();
    expect((await h.request(path, "POST", watch, { slot: 4 })).status).toBe(200);
    expect(h.tcl.executeAcActionVerified).toHaveBeenLastCalledWith(mom, { mode: 1, temperature: 23 }, expect.any(Function));
    expect(h.audits().every(a => a?.[3] === "watch")).toBe(true);
    expect(h.writes()).toHaveLength(1);
    expect(JSON.parse(String(h.writes()[0][1]?.[0]))).toEqual({ mode: 1, temperature: 23, power: 1, _preset_slot: 4 });
    for (const headers of [hermes, cookie()]) {
      expect((await h.request("/api/ac/preset-apply", "POST", headers, { deviceId: guest, slot: 8, presetData: { targetTemp: 27, generatorMode: 0 } })).status).toBe(200);
      expect(h.tcl.executeAcActionVerified).toHaveBeenLastCalledWith(guest, { temperature: 27, generator_mode: 0 }, expect.any(Function));
    }
  });

  it("validates model, command, type and range before the Xiaomi send and audits every caller", async () => {
    const h = await harness();
    h.purifiers.push(purifier(miot), purifier(miio));
    const send = (id: string, command: string, value: unknown) => h.request("/api/watch/purifier/" + id, "POST", watch, { command, value });
    for (const [id, cmd, value] of [
      ["unknown", "power", true], [miio, "fan", 1], [miio, "mode", "fan"], [miio, "favorite", 17],
      [miot, "favorite", 15], [miot, "fan", 4], [miot, "fan", 0], [miot, "fan", 1.5], [miot, "power", 1],
      [miot, "mode", "sleep"], [miot, "set_led", "on"], [miot, "favorite", -1], [miio, "favorite", "7"],
    ] as const) expect((await send(id, cmd, value)).status).toBeGreaterThanOrEqual(400);
    expect(h.xiaomi.sendControlCommand).not.toHaveBeenCalled();
    expect(h.audits()).toHaveLength(0);
    for (const [id, cmd, value, wire, arg] of [
      [miio, "favorite", 16, "set_level_favorite", 16], [miot, "favorite", 14, "set_level_favorite", 14],
      [miio, "favorite", 0, "set_level_favorite", 0], [miot, "fan", 3, "set_fan_level", 3],
      [miot, "mode", "fan", "set_mode", "fan"], [miio, "power", false, "set_power", "off"],
    ] as const) {
      expect((await send(id, cmd, value)).status).toBe(200);
      expect(h.xiaomi.sendControlCommand).toHaveBeenLastCalledWith(id, wire, [arg]);
      expect(h.audits().at(-1)?.slice(0, 4)).toEqual([id, "purifier:" + wire, JSON.stringify([arg]), "watch"]);
    }
    for (const [headers, actor] of [[hermes, "agent"], [cookie(), "user"], [{ ...hermes, ...cookie() }, "user"]] as const) {
      await h.request(`/api/devices/${miot}/control`, "POST", headers, { command: "set_mode", params: ["silent"] });
      expect(h.audits().at(-1)?.slice(0, 4)).toEqual([miot, "purifier:set_mode", '["silent"]', actor]);
    }
    expect(h.audits()).toHaveLength(h.xiaomi.sendControlCommand.mock.calls.length);
  });

  it("supersedes a saved preset still loading when a later dashboard power command arrives", async () => {
    const h = await harness();
    let fetched!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { fetched = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    h.query.mockImplementationOnce(async () => {
      fetched();
      await held;
      return { rows: [{ data: { targetTemp: 30 } }], rowCount: 1 };
    });
    const earlier = h.request(`/api/watch/ac/${mom}/preset`, "POST", watch, { slot: 4 });
    await started;
    try {
      const off = await h.request(`/api/ac/devices/${mom}/control`, "POST", cookie(), { command: "set_power", value: 0 });
      expect(off.status).toBe(200);
    } finally {
      release();
    }
    expect((await earlier).status).toBe(409);
    expect(h.tcl.executeAcActionVerified).not.toHaveBeenCalled();
    expect(h.writes()).toHaveLength(0);
  });
});

describe("watch readings", () => {
  it("carries humidity, feels-like and the 5-minute mean against the same 5 minutes yesterday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = Date.parse("2026-11-24T06:00:00.000Z"), day = 86_400_000;
    vi.setSystemTime(at);
    const h = await harness();
    const base = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql: string, args: unknown[] = []) => {
      const result = await base(sql, args);
      vi.setSystemTime(at + 2_000); // the reads take 2 s: the response clock moves past the SQL cutoff
      return result;
    });
    const watchWeather = async () => { vi.setSystemTime(at); return (await (await h.request("/api/watch")).json()).weather; };
    h.weather.push({ ts: new Date(at), temp_c: 19, humidity: 54, feels_like_c: 17.1, uv_index: 3 }, // at the SQL cutoff
      { ts: new Date(at - 300_000), temp_c: 18, humidity: 50, feels_like_c: 16 }, // window start, inclusive
      { ts: new Date(at - 300_001), temp_c: 30 }, // 1 ms outside today's 5 minutes
      { ts: new Date(at - day + 60_000), temp_c: 16.2 },
      { ts: new Date(at - day + 300_000), temp_c: 16.4 }, // yesterday's window end, inclusive
      { ts: new Date(at - day + 300_001), temp_c: 99 }, // 1 ms past it
      { ts: new Date(at - day + 120_000), temp_c: null },
      { ts: new Date(at - day - 1), temp_c: 5 }); // 1 ms before it
    const fresh = await watchWeather();
    expect(fresh).toMatchObject({ tempC: 19, humidity: 54, feelsLikeC: 17.1, uv: 3, vsYesterdayC: 2.2 }); // 18.5 - 16.3
    const yesterdaySql = h.query.mock.calls.find(([sql]) => sql.includes("WHERE ts >= $1 AND ts <= $2"));
    expect((yesterdaySql?.[1] as Date[]).map(d => d.getTime())).toEqual([at - day, at - day + 300_000]);
    h.weather.splice(3, 2); // no reading in yesterday's window: no comparison, never a zero
    expect(await watchWeather()).toMatchObject({ vsYesterdayC: null, humidity: 54 });
    h.weather.splice(0, 2); // nothing in today's 5 minutes
    h.weather.push({ ts: new Date(at - day + 90_000), temp_c: 15 });
    expect(await watchWeather()).toMatchObject({ vsYesterdayC: null });
  });
  it("shows a browser's successful purifier sample on the first watch poll, with its original time", async () => {
    const h = await harness();
    const sampled = Date.now() - 60_000;
    vi.spyOn(Date, "now").mockReturnValue(sampled);
    h.purifiers.push(purifier(miot));
    expect((await h.request("/api/devices", "GET", cookie())).status).toBe(200);
    vi.spyOn(Date, "now").mockReturnValue(sampled + 60_000);
    const snap = await (await h.request("/api/watch")).json();
    expect(snap.purifiers[1]).toMatchObject({ ts: sampled, pm25: 9 });
    expect(h.xiaomi.fetchDevicesLive).toHaveBeenCalledTimes(1);
  });
  it("returns cold 503 and partial 200 with nulls and independent sample clocks, without cloud I/O", async () => {
    const h = await harness();
    const now = Date.now(), weatherTs = now - 60_000, airTs = now - 90_000;
    const reconcile = vi.spyOn(h.collector, "reconcileAcManualOffLocks");
    const clear = vi.spyOn(h.collector, "clearAcManualOff");
    expect((await h.request("/api/watch")).status).toBe(503);
    h.air.push({ ts: new Date(airTs), co2: 1020 });
    const partial = await (await h.request("/api/watch")).json();
    expect(partial.weather).toEqual({ sky: null, isDay: null, tempC: null, feelsLikeC: null, humidity: null, uv: null,
      vsYesterdayC: null, windKmh: null, windDir: null, rainMmH: null, ts: null });
    expect(partial.air).toMatchObject({ ts: airTs, co2: 1020, co2Level: "moderate", pm25Level: null });
    expect(partial.power).toEqual({ source: null, amps: null, limit: null, ts: null });
    h.weather.push({ ts: new Date(weatherTs), wind_speed_kmh: 10, wind_dir_avg10m: 0, rain_hourly_mm: 0 },
      ...[2, 20, 4, NaN, null, Infinity].map(speed => ({ ts: new Date(now - 80_000), wind_speed_kmh: speed })),
      { ts: new Date(now - 660_000), wind_speed_kmh: 999 });
    const shadowTs = now - 180_000;
    h.devices.push(...[guest, "Cy3aihFAAAE", mom, "CA5IMhFAAAE"].map(id => device(id, shadowTs)));
    h.purifiers.push(purifier(miot), purifier(miio));
    vi.spyOn(h.collector, "getLatestAir").mockReturnValue({ ts: new Date(airTs + 1000), tvoc: 2 });
    vi.spyOn(h.collector, "getLatestPower").mockReturnValue({ ts: new Date(shadowTs), current_1: 16, current_2: 0 });
    const r = await h.request("/api/watch?format=v1", "GET", { ...watch, ...cookie() });
    expect(r.status).toBe(200);
    expect(r.headers.has("set-cookie")).toBe(false);
    const text = await r.text(), data = JSON.parse(text);
    expect(Buffer.byteLength(text)).toBeLessThan(3000);
    expect(data.weather).toMatchObject({ ts: weatherTs, windKmh: 7, rainMmH: 0, windDir: 0 });
    expect(data.air).toMatchObject({ ts: airTs + 1000, co2: null, tvocLevel: "good" });
    expect(airLevel("tvoc", 3)).toBe("good"); // excellent and good both read good
    expect(data.power).toEqual({ source: null, amps: null, limit: null, ts: null });
    expect(data.acs.map((d: AcDevice) => d.name)).toEqual(["ماما", "عبدو", "عبدالله", "الضيوف"]);
    expect(data.acs[0]).toMatchObject({ ts: shadowTs, mode: "cool", on: true, setC: 25, roomC: 26.5, fan: 3, gridOnly: false });
    expect(data.acs[3]).toMatchObject({ level: null, gridOnly: true, turnedDown: false });
    expect(data.purifiers.map((d: PurifierDevice) => d.name)).toEqual(["ماما", "عبدو"]);
    expect(data.purifiers[0]).toMatchObject({ fanLevel: null, favoriteMax: 16 });
    expect(data.purifiers[1]).toMatchObject({ fanLevel: 2, favoriteMax: 14, pm25Level: "good" });
    Object.assign(h.devices[0], { capabilities: { modes: [], fanSpeeds: [] }, power: false, powerKnown: false, powerReportedAt: null,
      mode: 0, targetTemp: 24, currentTemp: 0, targetTempKnown: false, currentTempKnown: false, fanSpeed: 0 });
    Object.assign(h.devices[1], { targetTemp: 24, targetTempKnown: true });
    h.weather.splice(0, h.weather.length, { ts: new Date(now - 660_000), wind_speed_kmh: 20, wind_dir_avg10m: 180 });
    const stale = await (await h.request("/api/watch")).json();
    expect(stale.acs[3]).toMatchObject({ mode: null, setC: null, roomC: null, fan: null, on: null });
    expect(stale.acs.find((a: { id: string }) => a.id === "Cy3aihFAAAE")).toMatchObject({ setC: 24 }); // a real 24 is not "missing"
    expect(stale.weather).toMatchObject({ windDir: null, windKmh: null });
    expect(h.xiaomi.fetchDevicesLive).not.toHaveBeenCalled();
    expect(h.tcl.fetchDevicesLive).not.toHaveBeenCalled();
    expect(h.tcl.getDevicesNoOlderThan).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("reads current shed, fan hold and lock state independently of the previous controller status", async () => {
    const h = await harness();
    h.devices.push(device(mom, Date.now()), device("CA5IMhFAAAE", Date.now()));
    vi.spyOn(h.collector, "getAcManualOffLockedIds").mockResolvedValue(new Set([mom]));
    const controller = h.collector.leveling();
    vi.spyOn(controller, "isShed").mockImplementation(id => id === mom);
    vi.spyOn(controller, "hasFanHold").mockImplementation(id => id === "CA5IMhFAAAE");
    const data = await (await h.request("/api/watch")).json();
    expect(data.acs[0]).toMatchObject({ manualOffLock: true, turnedDown: true });
    expect(data.acs[1]).toMatchObject({ manualOffLock: false, turnedDown: true });
    expect(data.acs[3]).toMatchObject({ turnedDown: false });
  });

  it("keeps the smoothed amps paired with the controller's sample even after a newer raw meter reading", async () => {
    const h = await harness(), now = Date.now(), ts = now - 5000;
    const state = h.collector.getWatchDeviceState();
    const observations = vi.spyOn(h.collector, "getWatchDeviceState").mockReturnValue({
      ...state, hasPowerReading: true, leveling: { ...state.leveling, enabled: true },
      meter: { controller: h.collector.acLeveler, source: "gen", amps: 12.36, limit: 15, ts },
    });
    const raw = vi.spyOn(h.collector, "getLatestPower").mockReturnValue({ ts: new Date(now), current_1: 0, current_2: 14 });
    expect((await (await h.request("/api/watch")).json()).power).toEqual({ source: "generator", amps: 12.4, limit: 15, ts });
    raw.mockReturnValue({ ts: new Date(now), current_1: 0, current_2: 0 });
    expect((await (await h.request("/api/watch")).json()).power).toEqual({ source: "generator", amps: 12.4, limit: 15, ts });
    observations.mockReturnValue({ ...state, hasPowerReading: true, meter: { controller: h.collector.acLeveler, source: "none", amps: null, limit: null, ts: now } });
    expect((await (await h.request("/api/watch")).json()).power).toEqual({ source: "none", amps: null, limit: null, ts: now });
    vi.spyOn(Date, "now").mockReturnValue(now + 15_001);
    expect((await (await h.request("/api/watch")).json()).power).toEqual({ source: null, amps: null, limit: null, ts: null });
  });

  it("refreshes both providers on watch-only demand, ages failed readings, and sleeps at two minutes", async () => {
    const h = await harness();
    // Fake the collector's timers only; undici and the local HTTP server stay live.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const start = Date.now(), ts = start - 10_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.xiaomi.fetchDevicesLive).not.toHaveBeenCalled();
    expect(h.tcl.getDevicesNoOlderThan).not.toHaveBeenCalled();
    const demandAt = Date.now();
    expect((await h.request("/api/watch")).status).toBe(503);
    const air = purifier(miot), ac = device(mom, ts);
    h.xiaomi.fetchDevicesLive.mockImplementation(async () => {
      if (!air.readingsStale) h.purifiers.splice(0, 2, { ...air, readingsAt: Date.now() });
      return h.purifiers;
    });
    h.tcl.getDevicesNoOlderThan.mockImplementation(async () => { h.devices.splice(0, 4, ac); return h.devices; });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.xiaomi.fetchDevicesLive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.xiaomi.fetchDevicesLive).toHaveBeenCalledTimes(1);
    expect(h.tcl.getDevicesNoOlderThan).toHaveBeenCalledTimes(1);
    let snap = await (await h.request("/api/watch")).json();
    expect(snap.acs[0]).toMatchObject({ ts, on: true });
    expect(snap.purifiers[1]).toMatchObject({ ts: demandAt + 15_000, pm25: 9 });
    air.aqi = 51;
    await vi.advanceTimersByTimeAsync(15_000);
    air.readingsStale = true;
    await vi.advanceTimersByTimeAsync(15_000);
    snap = await (await h.request("/api/watch")).json();
    expect(snap.purifiers[1]).toMatchObject({ ts: demandAt + 30_000, pm25: 51 });
    h.xiaomi.fetchDevicesLive.mockRejectedValue(new Error("unavailable"));
    h.tcl.getDevicesNoOlderThan.mockRejectedValue(new Error("unavailable"));
    await vi.advanceTimersByTimeAsync(15_000);
    snap = await (await h.request("/api/watch")).json();
    expect(snap.purifiers[1]).toMatchObject({ ts: demandAt + 30_000, pm25: 51 });
    expect(snap.acs[0].ts).toBe(ts);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.xiaomi.fetchDevicesLive).toHaveBeenCalledTimes(11); // first four + seven before expiry
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.xiaomi.fetchDevicesLive).toHaveBeenCalledTimes(11);
    expect(h.tcl.getDevicesNoOlderThan).toHaveBeenCalledTimes(11);
  });

  it("collapses inclusive dashboard bands, including every tVOC threshold", () => {
    for (const [metric, good, moderate, rest] of [
      ["co2", 1000, 2000, [3000]], ["pm25", 35, 75, [100]], ["tvoc", 37, 120, [293]],
    ] as const) {
      expect(airLevel(metric, null)).toBeNull();
      expect(airLevel(metric, good)).toBe("good");
      expect(airLevel(metric, good + 1)).toBe("moderate");
      expect(airLevel(metric, moderate)).toBe("moderate");
      for (const boundary of [moderate + 1, ...rest]) {
        expect(airLevel(metric, boundary)).toBe("bad");
        expect(airLevel(metric, boundary + 1)).toBe("bad");
      }
    }
  });

  it("matches the client sky states across Baghdad midnight, sunrise and seven minutes of radiation", () => {
    // Reference values from the client solar-model with TZ=Asia/Baghdad.
    const row = { solar_radiation: 300, rain_hourly_mm: 0, temp_c: 20, dew_point_c: 10, humidity: 65 };
    for (const [instant, day, label] of [
      ["2026-06-20T20:59Z", false, "clear_night"], ["2026-06-20T21:01Z", false, "clear_night"],
      ["2026-06-21T01:55Z", false, "clear_night"], ["2026-06-21T02:00Z", true, null],
      ["2026-06-21T02:25Z", true, null], ["2026-06-21T02:30Z", true, "sunny"],
    ] as const) {
      const ts = Date.parse(instant);
      expect(watchSun(ts).isDay).toBe(day);
      expect(watchSky(row, [], ts)).toBe(label);
    }
    expect(watchSun(Date.parse("2026-06-21T02:30Z")).ghi).toBeCloseTo(2.2558391555313135, 10);
    // Both sides of local New Year's midnight are dark. Elevation, unlike
    // the night label alone, detects an accidental UTC year/day-of-year.
    for (const [instant, elevation] of [
      ["2026-12-31T20:59Z", -79.67926327534707], ["2026-12-31T21:00Z", -79.62021940649703],
      ["2026-06-21T01:57Z", -0.11311931049117928], ["2026-06-21T01:58Z", 0.07054240755986696],
    ] as const) expect(watchSun(Date.parse(instant)).elevation).toBeCloseTo(elevation, 10);
    const night = Date.parse("2026-12-31T21:00Z");
    expect(watchSky({ ...row, humidity: 85 }, [], night)).toBe("cloudy_night");
    expect(watchSky({ ...row, rain_hourly_mm: 2.5 }, [], night)).toBe("light_rain");
    expect(watchSky({ ...row, rain_hourly_mm: 2.6 }, [], night)).toBe("heavy_rain");
    const ts = Date.parse("2026-06-21T09:00Z");
    const sample = (at: number, csi: number) => ({ ts: at, solar_radiation: watchSun(at).ghi * csi });
    expect(watchSky(sample(ts, 0.7), [], ts)).toBe("partly_cloudy");
    expect(watchSky(sample(ts, 0.4), [], ts)).toBe("mostly_cloudy");
    expect(watchSky(sample(ts, 0.1), [], ts)).toBe("cloudy");
    const history = [sample(ts - 60000, 0.1), sample(ts - 420000, 0.1)];
    expect(watchSky(sample(ts, 1), history, ts)).toBe("cloudy");
    expect(watchSky(sample(ts, 1), [sample(ts - 420001, 0), sample(ts + 1, 0)], ts)).toBe("sunny");
  });
});
