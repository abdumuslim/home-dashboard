import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Config } from "./config.js";
import { Collector } from "./collector.js";
import { acTimers } from "./routes.js";
import type { AutomationRangeSlot } from "./automation-slots.js";

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
  hermesApiToken: "",
};

function createPool() {
  const locks = new Set<string>();
  const shed = new Set<string>();
  let levelingConfig: Record<string, unknown> | null = null;
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
    if (sql.includes("FROM ac_leveling_config")) {
      return { rows: levelingConfig ? [{ config: levelingConfig }] : [], rowCount: levelingConfig ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO ac_leveling_config")) {
      levelingConfig = JSON.parse(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT") && sql.includes("FROM ac_leveling_shed")) {
      return { rows: Array.from(shed).map((device_id) => ({ device_id, shed_at: new Date(Date.now() - 60_000) })), rowCount: shed.size };
    }
    if (sql.includes("INSERT INTO ac_leveling_shed")) {
      shed.add(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM ac_leveling_shed")) {
      shed.delete(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    pool: { query },
    locks,
    shed,
    setLevelingConfig: (c: Record<string, unknown>) => { levelingConfig = c; },
  };
}

const LEVELING_CONFIG = {
  enabled: true,
  gridLimitAmps: 30,
  genLimitAmps: 15,
  marginAmps: 1,
  comfortTargetC: 26,
  priority: ["ac1", "ac2"],
  ampModels: { ac1: { baseAmps: 2, stepAmps: 1 }, ac2: { baseAmps: 4, stepAmps: 2 } },
};

function createCollector() {
  const { pool, locks, shed, setLevelingConfig } = createPool();
  const collector = new Collector(pool as never, config);
  const actions: Array<{ deviceId: string; action: Record<string, unknown> }> = [];
  const tclCloud = {
    isReady: vi.fn(() => true),
    ensureDeviceCachePopulated: vi.fn(async () => undefined),
    getDevices: vi.fn(() => [] as Record<string, unknown>[]),
    fetchDevicesLive: vi.fn(async () => [{ id: "ac1", power: false }]),
    executeAcAction: vi.fn(async (deviceId: string, action: Record<string, unknown>) => {
      actions.push({ deviceId, action });
    }),
    sendControl: vi.fn(async () => undefined),
    computeAcDiff: vi.fn(() => null as Record<string, unknown> | null),
    getDeviceState: vi.fn(() => null as Record<string, unknown> | null),
  };

  (collector as never as { tclCloud: typeof tclCloud }).tclCloud = tclCloud;
  (collector as never as { latestWeatherTs: Date }).latestWeatherTs = new Date();
  (collector as never as { latestWeatherRow: Record<string, unknown> }).latestWeatherRow = {
    temp_indoor_c: 23,
  };

  return { collector, tclCloud, actions, locks, shed, setLevelingConfig };
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
    range_slots: null as AutomationRangeSlot[] | null,
  };
}

function acRangeRuleWithSlots() {
  return {
    ...acRangeRule(),
    range_slots: [
      { id: "default", type: "all_day", threshold_low: 20, threshold: 28 },
      { id: "morning", type: "window", start_mode: "exact", start_time: "06:00", end_mode: "exact", end_time: "10:00", threshold_low: 22, threshold: 25 },
    ] satisfies AutomationRangeSlot[],
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

  it("uses the active range slot thresholds for AC hysteresis", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T04:30:00.000Z")); // 07:30 Baghdad
    try {
      const { collector, actions } = createCollector();

      await setWeatherValue(collector, 25.5);
      await checkAcRangeAutomation(collector, acRangeRuleWithSlots());

      expect(actions).toEqual([{ deviceId: "ac1", action: { power: 1, mode: 1, temperature: 23, fan_speed: 3 } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns an AC off when no range slot is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T09:00:00.000Z")); // 12:00 Baghdad
    try {
      const { collector, tclCloud, actions } = createCollector();
      tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);

      await setWeatherValue(collector, 25.5);
      await checkAcRangeAutomation(collector, {
        ...acRangeRule(),
        range_slots: [
          { id: "morning", type: "window", start_mode: "exact", start_time: "06:00", end_mode: "exact", end_time: "10:00", threshold_low: 22, threshold: 25 },
        ] satisfies AutomationRangeSlot[],
      });

      expect(actions).toEqual([{ deviceId: "ac1", action: { power: 0 } }]);
      await expect((collector as never as { isAcManualOffLocked: (id: string) => Promise<boolean> }).isAcManualOffLocked("ac1")).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a manual-off lock across later range slots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T04:30:00.000Z")); // 07:30 Baghdad
    try {
      const { collector, actions } = createCollector();
      await (collector as never as { recordAcManualOff: (id: string, reason: string) => Promise<void> }).recordAcManualOff("ac1", "test");

      await setWeatherValue(collector, 25.5);
      await checkAcRangeAutomation(collector, acRangeRuleWithSlots());

      expect(actions).toEqual([]);
      await expect((collector as never as { isAcManualOffLocked: (id: string) => Promise<boolean> }).isAcManualOffLocked("ac1")).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

function setTriggered(collector: Collector, ruleId: number) {
  (collector as never as { automationState: Map<number, unknown> }).automationState.set(ruleId, {
    status: "triggered", lastToggle: 0, conditionSince: null, conditionLostAt: null, canAutoTurnOn: true,
  });
}

function acFanRule(slotFan?: number, presetFan = 3) {
  return {
    ...acRangeRule(),
    action_on: { power: 1, mode: 1, temperature: 23, fan_speed: presetFan },
    range_slots: [
      { id: "morning", type: "window", start_mode: "exact", start_time: "06:00", end_mode: "exact", end_time: "10:00", threshold_low: 22, threshold: 25, ...(slotFan != null ? { fan_speed: slotFan } : {}) },
      { id: "default", type: "all_day", threshold_low: 20, threshold: 28 },
    ] satisfies AutomationRangeSlot[],
  };
}

function getFanEnforcement(collector: Collector) {
  return (collector as never as { acFanEnforcement: Map<string, { manual: boolean }> }).acFanEnforcement;
}

describe("AC range fan enforcement", () => {
  beforeEach(() => {
    acTimers.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T04:30:00.000Z")); // 07:30 Baghdad — morning slot active
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies the slot fan speed on turn-on instead of the preset fan", async () => {
    const { collector, actions } = createCollector();

    await setWeatherValue(collector, 25.5);
    await checkAcRangeAutomation(collector, acFanRule(2));

    expect(actions).toEqual([{ deviceId: "ac1", action: { power: 1, mode: 1, temperature: 23, fan_speed: 2 } }]);
  });

  it("applies the slot fan speed in triggered re-enforcement", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, acFanRule(2));

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 2 });
  });

  it("falls back to the preset fan when the slot has no override", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, acFanRule());

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 3 });
  });

  it("resolves slot Auto to the delta-based level and follows the delta", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    tclCloud.getDeviceState.mockReturnValue({ fan_speed: 2 });

    setTriggered(collector, 1);
    await setWeatherValue(collector, 22.7); // delta 0.7 past the low limit → L2
    await checkAcRangeAutomation(collector, acFanRule(0));
    expect(tclCloud.computeAcDiff).toHaveBeenLastCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 2 });

    vi.setSystemTime(new Date("2026-05-20T04:31:00.000Z"));
    await setWeatherValue(collector, 25.0); // delta 3.0 → L7
    await checkAcRangeAutomation(collector, acFanRule(0));
    expect(tclCloud.computeAcDiff).toHaveBeenLastCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 7 });
  });

  it("resolves a preset Auto fan to the delta-based level (never sends 0)", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 22.7);
    await checkAcRangeAutomation(collector, acFanRule(undefined, 0));

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 2 });
  });

  it("detects a manual fan change and stops enforcing fan and turbo", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    tclCloud.getDeviceState.mockReturnValue({ fan_speed: 2 });
    const rule = { ...acFanRule(2), action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3, turbo: 0 } };

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, rule); // baseline adopted (observed == desired)

    vi.setSystemTime(new Date("2026-05-20T04:30:20.000Z")); // +20s — past the settle window
    tclCloud.getDeviceState.mockReturnValue({ fan_speed: 5 });
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenLastCalledWith("ac1", { mode: 1, temperature: 23 });
    expect(getFanEnforcement(collector).get("1:ac1")?.manual).toBe(true);
  });

  it("keeps enforcing fan when drift is within the settle window", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    tclCloud.getDeviceState.mockReturnValue({ fan_speed: 2 });

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, acFanRule(2)); // baseline adopted

    vi.setSystemTime(new Date("2026-05-20T04:30:05.000Z")); // +5s — inside the settle window
    tclCloud.getDeviceState.mockReturnValue({ fan_speed: 5 });
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, acFanRule(2));

    expect(tclCloud.computeAcDiff).toHaveBeenLastCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 2 });
    expect(getFanEnforcement(collector).get("1:ac1")?.manual).toBe(false);
  });

  it("resumes fan enforcement when the active slot changes", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    getFanEnforcement(collector).set("1:ac1", { slotId: "morning", lastCommandedFan: 5, lastFanCommandAt: 0, manual: true } as never);

    vi.setSystemTime(new Date("2026-05-20T09:00:00.000Z")); // 12:00 Baghdad — all-day slot active
    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, acFanRule(2));

    expect(tclCloud.computeAcDiff).toHaveBeenLastCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 3 });
  });

  it("drops the manual override when the AC is observed off (power cycle)", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: false }]);
    getFanEnforcement(collector).set("1:ac1", { slotId: "morning", lastCommandedFan: 5, lastFanCommandAt: 0, manual: true } as never);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, acFanRule(2));

    expect(getFanEnforcement(collector).has("1:ac1")).toBe(false);
  });

  it("suspends fan enforcement immediately on a UI fan change", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    const rule = acFanRule(2);
    (collector as never as { automationRules: unknown[] }).automationRules = [rule];

    collector.noteUserAcFanChange("ac1");
    expect(getFanEnforcement(collector).get("1:ac1")?.manual).toBe(true);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenLastCalledWith("ac1", { mode: 1, temperature: 23 });
  });
});

async function checkAcLeveling(collector: Collector) {
  await (collector as never as { checkAcLeveling: () => Promise<void> }).checkAcLeveling();
}

describe("Smart AC leveling", () => {
  beforeEach(() => {
    acTimers.clear();
  });

  it("does not record a manual-off lock or auto-on a leveler-shed AC", async () => {
    const { collector, actions, locks, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    shed.add("ac1");
    await collector.acLeveler.ensureLoaded();

    // Triggered + device off in the dead zone → observed-off path must skip the lock
    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, acRangeRule());
    expect(locks.size).toBe(0);
    expect(actions).toEqual([]);

    // Idle + above the high limit → auto-on must skip the shed device
    (collector as never as { automationState: Map<number, unknown> }).automationState.delete(1);
    await setWeatherValue(collector, 27);
    await checkAcRangeAutomation(collector, acRangeRule());
    expect(actions).toEqual([]);
  });

  it("strips generator_mode from re-enforcement when smart leveling owns the device", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    const rule = { ...acRangeRule(), action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3, generator_mode: 2 } };
    await checkAcRangeAutomation(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 3 });
  });

  it("keeps generator_mode in re-enforcement when the automation opts out", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    const rule = { ...acRangeRule(), smart_leveling: false, action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3, generator_mode: 2 } };
    await checkAcRangeAutomation(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 3, generator_mode: 2 });
  });

  it("strips generator_mode from turn-on timer presets for managed devices", async () => {
    const { collector, actions, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    acTimers.set("ac1", { deviceId: "ac1", action: "on", fireAt: Date.now() - 1, preset: { mode: 1, generator_mode: 2 } });

    await checkAcTimers(collector);

    expect(actions).toEqual([{ deviceId: "ac1", action: { power: 1, mode: 1 } }]);
  });

  it("drops a due turn-on timer for a shed AC without sending a command", async () => {
    const { collector, actions, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    shed.add("ac1");
    await collector.acLeveler.ensureLoaded();
    acTimers.set("ac1", { deviceId: "ac1", action: "on", fireAt: Date.now() - 1 });

    await checkAcTimers(collector);

    expect(acTimers.has("ac1")).toBe(false);
    expect(actions).toEqual([]);
  });

  it("sheds the lowest-priority AC after a sustained over-limit on the generator", async () => {
    const { collector, tclCloud, actions, shed, locks, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 4 consecutive generator readings over the 15A limit
    for (let i = 0; i < 4; i++) {
      collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: 16, power_1: 0, power_2: 3520 });
    }
    await checkAcLeveling(collector);

    // budget = 15 − 1 − nonAcLoad(16 − 6) = 4 < L1 sum 6 → shed ac2 (lowest priority)
    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 0 } }]);
    expect(shed.has("ac2")).toBe(true);
    expect(locks.size).toBe(0); // shed is not a manual-off lock
  });

  it("raises a boosted AC to its minimum level when it's hot outside", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig({ ...LEVELING_CONFIG, levelBoosts: { ac1: { minLevel: 2, outdoorAtLeastC: 37 } } });
    await collector.acLeveler.ensureLoaded();
    (collector as never as { latestWeatherRow: Record<string, unknown> }).latestWeatherRow = { temp_c: 38 };
    (collector as never as { latestWeatherTs: Date }).latestWeatherTs = new Date();
    const devices = [
      { id: "ac1", name: "Abdullah", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Single reading with headroom — raise gating NOT met, floor correction must still fire
    collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: 4, power_1: 0, power_2: 880 });
    await checkAcLeveling(collector);

    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 2);
  });

  it("restores a shed AC when headroom returns", async () => {
    const { collector, tclCloud, actions, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    shed.add("ac2");
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 26, mode: 1 },
      { id: "ac2", name: "Abdu", power: false, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 6 consecutive readings with comfortable headroom on the generator
    for (let i = 0; i < 6; i++) {
      collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: 4, power_1: 0, power_2: 880 });
    }
    await checkAcLeveling(collector);

    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 1, generator_mode: 1 } }]);
    expect(shed.has("ac2")).toBe(false);
  });
});
