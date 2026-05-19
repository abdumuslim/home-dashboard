import { describe, expect, it, beforeEach, vi } from "vitest";
import type { Config } from "./config.js";
import { Collector } from "./collector.js";
import { acTimers } from "./routes.js";

const config: Config = {
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
  authSecret: "",
  adminUser: "",
  adminPassword: "",
};

function createPool() {
  const locks = new Set<string>();
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("SELECT") && sql.includes("FROM ac_manual_off_locks")) {
      return { rows: Array.from(locks).map((device_id) => ({ device_id, locked_at: new Date(Date.now() - 20_000) })), rowCount: locks.size };
    }
    if (sql.includes("INSERT INTO ac_manual_off_locks")) {
      locks.add(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM ac_manual_off_locks")) {
      locks.delete(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query }, locks };
}

function createCollector() {
  const { pool, locks } = createPool();
  const collector = new Collector(pool as never, config);
  const actions: Array<{ deviceId: string; action: Record<string, unknown> }> = [];
  const tclCloud = {
    isReady: vi.fn(() => true),
    ensureDeviceCachePopulated: vi.fn(async () => undefined),
    fetchDevicesLive: vi.fn(async () => [{ id: "ac1", power: false }]),
    executeAcAction: vi.fn(async (deviceId: string, action: Record<string, unknown>) => {
      actions.push({ deviceId, action });
    }),
    computeAcDiff: vi.fn(() => null as Record<string, unknown> | null),
  };

  (collector as never as { tclCloud: typeof tclCloud }).tclCloud = tclCloud;
  (collector as never as { latestWeatherTs: Date }).latestWeatherTs = new Date();
  (collector as never as { latestWeatherRow: Record<string, unknown> }).latestWeatherRow = {
    temp_indoor_c: 23,
  };

  return { collector, tclCloud, actions, locks };
}

function acRangeRule() {
  return {
    id: 1,
    name: "Mom AC range",
    enabled: true,
    automation_type: "metric",
    device_type: "ac",
    metric: "temp_indoor_c",
    condition: "above",
    threshold: 26,
    threshold_low: 22,
    time_start: null,
    time_end: null,
    device_id: "ac1",
    device_name: "Mom",
    device_ids: ["ac1"],
    device_names: ["Mom"],
    turn_off_at_end: true,
    sustained_minutes: 0,
    start_mode: "exact",
    start_prayer: null,
    start_prayer_offset: null,
    end_mode: "exact",
    end_prayer: null,
    end_prayer_offset: null,
    action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3 },
    action_off: { power: 0 },
    cooldown_secs: 0,
  };
}

function activeScheduleRule() {
  const baghdadNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Baghdad" }));
  const start = new Date(baghdadNow.getTime() - 60_000);
  const end = new Date(baghdadNow.getTime() + 60_000);
  const fmt = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

  return {
    ...acRangeRule(),
    id: 2,
    name: "Mom schedule",
    automation_type: "schedule",
    metric: null,
    condition: null,
    threshold: null,
    threshold_low: null,
    time_start: fmt(start),
    time_end: fmt(end),
    cooldown_secs: 0,
  };
}

async function checkAcRangeAutomation(collector: Collector, rule: ReturnType<typeof acRangeRule>) {
  await (collector as never as { checkAcRangeAutomation: (r: unknown) => Promise<void> }).checkAcRangeAutomation(rule);
}

async function checkScheduleAutomation(collector: Collector, rule: ReturnType<typeof activeScheduleRule>) {
  await (collector as never as { checkScheduleAutomation: (r: unknown) => Promise<void> }).checkScheduleAutomation(rule);
}

async function checkAcTimers(collector: Collector) {
  await (collector as never as { checkAcTimers: () => Promise<void> }).checkAcTimers();
}

async function setWeatherValue(collector: Collector, value: number) {
  (collector as never as { latestWeatherRow: Record<string, unknown> }).latestWeatherRow = { temp_indoor_c: value };
  (collector as never as { latestWeatherTs: Date }).latestWeatherTs = new Date();
}

describe("AC manual-off locks", () => {
  beforeEach(() => {
    acTimers.clear();
  });

  it("keeps a cool-mode range automation locked after the low limit and skips the next high-limit auto-on", async () => {
    const { collector, actions } = createCollector();
    await (collector as never as { recordAcManualOff: (id: string, reason: string) => Promise<void> }).recordAcManualOff("ac1", "test");

    await setWeatherValue(collector, 21);
    await checkAcRangeAutomation(collector, acRangeRule());
    await setWeatherValue(collector, 27);
    await checkAcRangeAutomation(collector, acRangeRule());

    await expect((collector as never as { isAcManualOffLocked: (id: string) => Promise<boolean> }).isAcManualOffLocked("ac1")).resolves.toBe(true);
    expect(actions).toEqual([]);
  });

  it("clears the lock when the collector observes the AC on and adopts the active range profile", async () => {
    const { collector, tclCloud, actions } = createCollector();
    await (collector as never as { recordAcManualOff: (id: string, reason: string) => Promise<void> }).recordAcManualOff("ac1", "test");
    (collector as never as { acManualOffLockTimes: Map<string, number> }).acManualOffLockTimes.set("ac1", Date.now() - 20_000);
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    tclCloud.computeAcDiff.mockReturnValue({ temperature: 23 });

    await setWeatherValue(collector, 27);
    await checkAcRangeAutomation(collector, acRangeRule());

    await expect((collector as never as { isAcManualOffLocked: (id: string) => Promise<boolean> }).isAcManualOffLocked("ac1")).resolves.toBe(false);
    expect(actions).toEqual([{ deviceId: "ac1", action: { temperature: 23 } }]);
  });

  it("does not clear a fresh lock from stale on-state reads", async () => {
    const { collector, tclCloud, actions } = createCollector();
    await (collector as never as { recordAcManualOff: (id: string, reason: string) => Promise<void> }).recordAcManualOff("ac1", "test");
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    tclCloud.computeAcDiff.mockReturnValue({ temperature: 23 });

    await setWeatherValue(collector, 27);
    await checkAcRangeAutomation(collector, acRangeRule());

    await expect((collector as never as { isAcManualOffLocked: (id: string) => Promise<boolean> }).isAcManualOffLocked("ac1")).resolves.toBe(true);
    expect(actions).toEqual([]);
  });

  it("does not turn on a locked AC during an active schedule window", async () => {
    const { collector, actions } = createCollector();
    await (collector as never as { recordAcManualOff: (id: string, reason: string) => Promise<void> }).recordAcManualOff("ac1", "test");

    await checkScheduleAutomation(collector, activeScheduleRule());

    expect(actions).toEqual([]);
  });

  it("drops a due turn-on timer for a locked AC without sending a command", async () => {
    const { collector, actions } = createCollector();
    await (collector as never as { recordAcManualOff: (id: string, reason: string) => Promise<void> }).recordAcManualOff("ac1", "test");
    acTimers.set("ac1", { deviceId: "ac1", action: "on", fireAt: Date.now() - 1 });

    await checkAcTimers(collector);

    expect(acTimers.has("ac1")).toBe(false);
    expect(actions).toEqual([]);
  });

  it("records a manual-off lock when a turn-off timer fires", async () => {
    const { collector, actions } = createCollector();
    acTimers.set("ac1", { deviceId: "ac1", action: "off", fireAt: Date.now() - 1 });

    await checkAcTimers(collector);

    expect(actions).toEqual([{ deviceId: "ac1", action: { power: 0 } }]);
    await expect((collector as never as { isAcManualOffLocked: (id: string) => Promise<boolean> }).isAcManualOffLocked("ac1")).resolves.toBe(true);
  });
});
