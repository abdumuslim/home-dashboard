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
  const fanHolds = new Map<string, { original_fan: number; last_set_fan: number }>();
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
    if (sql.includes("SELECT") && sql.includes("FROM ac_leveling_fan_hold")) {
      return {
        rows: Array.from(fanHolds, ([device_id, h]) => ({ device_id, ...h })),
        rowCount: fanHolds.size,
      };
    }
    if (sql.includes("INSERT INTO ac_leveling_fan_hold")) {
      if (!fanHolds.has(String(params[0]))) {
        fanHolds.set(String(params[0]), { original_fan: Number(params[1]), last_set_fan: Number(params[1]) });
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE ac_leveling_fan_hold")) {
      const hold = fanHolds.get(String(params[0]));
      if (hold) fanHolds.set(String(params[0]), { ...hold, last_set_fan: Number(params[1]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM ac_leveling_fan_hold")) {
      fanHolds.delete(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    pool: { query },
    locks,
    shed,
    fanHolds,
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
  const { pool, locks, shed, fanHolds, setLevelingConfig } = createPool();
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

  return { collector, tclCloud, actions, locks, shed, fanHolds, setLevelingConfig };
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

  it("reduces levels instantly when an AC turns on near the limit", async () => {
    const { collector, tclCloud, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();

    // Tick 1: only Najat running at L4 (est 5A), generator at 12A — under the
    // 15A limit but close to it. Nothing to do.
    const before = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 4, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: false, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(before);
    tclCloud.fetchDevicesLive.mockResolvedValue(before as never);
    // 3 readings at 12A — headroom streak 3 (< 6, raise gating NOT met)
    for (let i = 0; i < 3; i++) {
      collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: 12, power_1: 0, power_2: 2640 });
    }
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).not.toHaveBeenCalled();

    // Tick 2: Abdu turns ON (est 4A at L1) while measured is still 12A — the
    // compressor hasn't ramped, so there are ZERO over-limit readings. The
    // leveler must NOT subtract Abdu's estimated draw from the measured load
    // (nonAcLoad stays 12−5=7 → budget 7) and must reduce Najat immediately.
    const after = [{ ...before[0] }, { ...before[1], power: true }];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    await checkAcLeveling(collector);

    // floors 2+4=6 ≤ 7, one raise step fits → ideal { ac1: 2, ac2: 1 } → Najat L4→L2 now
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 2);
    expect(shed.size).toBe(0);
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

function overLimitReadings(collector: Collector, count: number) {
  for (let i = 0; i < count; i++) {
    collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: 16, power_1: 0, power_2: 3520 });
  }
}

function headroomReadings(collector: Collector, count: number) {
  for (let i = 0; i < count; i++) {
    collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: 4, power_1: 0, power_2: 880 });
  }
}

function genReadings(collector: Collector, amps: number, count: number) {
  for (let i = 0; i < count; i++) {
    collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: amps, power_1: 0, power_2: amps * 220 });
  }
}

describe("Smart AC leveling — predictive control", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ac1 Najat est L4 = 5A; ac2 Abdu est L3 = 8A (models from LEVELING_CONFIG)
  function twoRunningAcs() {
    return [
      { id: "ac1", name: "Najat", power: true, generatorMode: 4, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
  }

  it("reduces raised ACs to make room and restores a shed AC in one batch", async () => {
    const { collector, tclCloud, actions, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    shed.add("ac2");
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 4, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: false, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 11A on gen → nonAcLoad 11−5=6, budget 8. Old feasibility used current
    // levels (5A) + abdu floor (4A) = 9 > 8 and blocked the restore forever.
    // Floors 2+4=6 fit → reduce Najat L4→L3 and restore Abdu in one batch.
    genReadings(collector, 11, 6);
    await checkAcLeveling(collector);

    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 3);
    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 1, generator_mode: 1 } }]);
    expect(shed.has("ac2")).toBe(false);
    // Room is made before the power-on: reduction precedes the restore
    const reduceOrder = tclCloud.sendControl.mock.invocationCallOrder[0];
    const restoreOrder = tclCloud.executeAcAction.mock.invocationCallOrder[0];
    expect(reduceOrder).toBeLessThan(restoreOrder);
  });

  it("freezes the non-AC load after a reduction so stale readings cannot spiral", async () => {
    const { collector, tclCloud, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = twoRunningAcs();
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 16A over the 15A gen limit → nonAcLoad 16−13=3, budget 11 → Abdu L3→L2
    genReadings(collector, 16, 4);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 2);

    // 8s later the compressor hasn't responded — measured still 16A. A fresh
    // derivation would read nonAcLoad = 16−(5+6) = 5 and over-reduce Najat;
    // the frozen value (3) reproduces the already-commanded allocation.
    vi.advanceTimersByTime(8_000);
    genReadings(collector, 16, 4);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(shed.size).toBe(0);

    // Past the freeze window the persistent 16A is real — derivation resumes
    // (nonAcLoad 5 → budget 9) and the leveler reduces further.
    vi.advanceTimersByTime(8_000);
    genReadings(collector, 16, 4);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(2);
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac1", "set_generator_mode", 2);
  });

  it("reports expectedAmps on the command tick and grades it after effects settle", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = twoRunningAcs();
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    genReadings(collector, 16, 4);
    await checkAcLeveling(collector);
    // Same-tick status: nonAcLoad 3 + Najat@L4 (5) + Abdu@L2 (6) = 14A expected
    expect(collector.acLeveler.getStatus().expectedAmps).toBe(14);
    expect(collector.acLeveler.getStatus().lastPrediction).toBeNull();

    // Shadow catches up with the commanded level; settle (30s) passes and the
    // measured total matches the prediction.
    const after = [{ ...devices[0] }, { ...devices[1], generatorMode: 2 }];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 14, 4);
    await checkAcLeveling(collector);

    const status = collector.acLeveler.getStatus();
    expect(status.expectedAmps).toBeNull();
    expect(status.lastPrediction).toMatchObject({ expectedAmps: 14, actualAmps: 14 });
  });

  it("keeps a freshly turned-on AC out of the established draw for the full 90s ramp", async () => {
    const { collector, tclCloud, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const before = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 4, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: false, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(before);
    tclCloud.fetchDevicesLive.mockResolvedValue(before as never);
    genReadings(collector, 12, 3);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).not.toHaveBeenCalled();

    // Abdu turns ON near the limit → instant proactive reduction of Najat
    const after = [{ ...before[0] }, { ...before[1], power: true }];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 2);

    // 60s in (past the old 30s window): Abdu is still ramping — his estimate
    // must stay OUT of establishedDraw, so nonAcLoad = 12 − Najat@L2 (3) = 9.
    const settled = [{ ...after[0], generatorMode: 2 }, { ...after[1] }];
    tclCloud.getDevices.mockReturnValue(settled);
    tclCloud.fetchDevicesLive.mockResolvedValue(settled as never);
    vi.advanceTimersByTime(60_000);
    genReadings(collector, 12, 1);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().nonAcLoadAmps).toBe(9);
    expect(shed.size).toBe(0);

    // Past 90s the compressor is established: nonAcLoad = 12 − 3 − 4 = 5
    vi.advanceTimersByTime(35_000);
    genReadings(collector, 12, 1);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().nonAcLoadAmps).toBe(5);
  });

  it("holds further raises for 60s when a raise does not draw the expected amps", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 12A on gen → nonAcLoad 12−6=6, budget 8 → Najat raised L1→L3 (+2A expected)
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 3);

    // Settle passes but measured never rises — the cap rose, the draw didn't.
    // The fake headroom would now fit Abdu L2; the raise-miss hold must block it.
    const after = [{ ...devices[0], generatorMode: 3 }, { ...devices[1] }];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 12, 4);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(collector.acLeveler.getStatus().raiseHoldRemainingMs).toBeGreaterThan(0);

    // After the 60s hold expires the next (single) raise is allowed again
    vi.advanceTimersByTime(65_000);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(2);
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac2", "set_generator_mode", 2);
  });

  it("suspends AC automations, timers, and the leveler while calibration runs", async () => {
    const { collector, tclCloud, actions, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = twoRunningAcs();
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    genReadings(collector, 9, 1);
    const started = await collector.acCalibrator.start(["ac1"], false);
    expect(started).toEqual({ ok: true });

    // AC automation rules are skipped in the loop (no turn-on despite 27° > 26)
    await setWeatherValue(collector, 27);
    (collector as never as { automationRules: unknown[] }).automationRules = [acRangeRule()];
    (collector as never as { automationRulesLastFetch: number }).automationRulesLastFetch = Date.now();
    await (collector as never as { checkAutomations: () => Promise<void> }).checkAutomations();
    expect(actions).toEqual([]);

    // Due AC timers stay pending (fire late, after the run)
    acTimers.set("ac1", { deviceId: "ac1", action: "off", fireAt: Date.now() - 1 });
    await checkAcTimers(collector);
    expect(acTimers.has("ac1")).toBe(true);
    acTimers.clear();

    // The leveler stands down even with a sustained over-limit
    genReadings(collector, 16, 4);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).not.toHaveBeenCalled();
    expect(shed.size).toBe(0);

    await collector.acCalibrator.abort("test_cleanup");
  });

  it("clears the pending expectation when the power source changes", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = twoRunningAcs();
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    genReadings(collector, 16, 4);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().expectedAmps).toBe(14);

    // Changeover to grid — the gen expectation is meaningless now
    collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 10, current_2: 0, power_1: 2200, power_2: 0 });
    await checkAcLeveling(collector);
    const status = collector.acLeveler.getStatus();
    expect(status.expectedAmps).toBeNull();
    expect(status.lastPrediction).toBeNull();
  });
});

describe("Smart AC leveling — fan reduction before shed", () => {
  beforeEach(() => {
    acTimers.clear();
  });

  it("reduces all reducible fans to 1 instead of shedding on a sustained over-limit", async () => {
    const { collector, tclCloud, actions, shed, fanHolds, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1, fanSpeed: 3 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1, fanSpeed: 5 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    overLimitReadings(collector, 4);
    await checkAcLeveling(collector);

    // budget 4 < L1 floors 6 → fans drop first; nobody is powered off
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_fan_speed", 1);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_fan_speed", 1);
    expect(actions).toEqual([]);
    expect(shed.size).toBe(0);
    expect(fanHolds.get("ac1")).toEqual({ original_fan: 3, last_set_fan: 1 });
    expect(fanHolds.get("ac2")).toEqual({ original_fan: 5, last_set_fan: 1 });

    // Status (next tick) exposes the hold
    await checkAcLeveling(collector);
    const status = collector.acLeveler.getStatus().acs.find((a) => a.deviceId === "ac1");
    expect(status?.heldFan).toBe(1);
    expect(status?.fanOriginal).toBe(3);
  });

  it("sheds only after a fresh over-limit window builds with fans already at minimum", async () => {
    const { collector, tclCloud, actions, shed, fanHolds, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1, fanSpeed: 3 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1, fanSpeed: 5 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    overLimitReadings(collector, 4);
    await checkAcLeveling(collector); // fan reduce + streak reset

    overLimitReadings(collector, 3);
    await checkAcLeveling(collector);
    expect(actions).toEqual([]); // 3 < 4 — fresh window not complete

    overLimitReadings(collector, 1);
    await checkAcLeveling(collector);

    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 0 } }]);
    expect(shed.has("ac2")).toBe(true);
    expect(fanHolds.has("ac2")).toBe(false); // shed releases the hold
    expect(fanHolds.has("ac1")).toBe(true);
  });

  it("restores held fans one gated step at a time and suppresses gen raises meanwhile", async () => {
    const { collector, tclCloud, fanHolds, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    fanHolds.set("ac1", { original_fan: 3, last_set_fan: 1 });
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1, fanSpeed: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    headroomReadings(collector, 6);
    await checkAcLeveling(collector);

    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_fan_speed", 2);
    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac1", "set_generator_mode", expect.anything());
    expect(fanHolds.get("ac1")).toEqual({ original_fan: 3, last_set_fan: 2 });
  });

  it("releases the hold and re-baselines fan enforcement when the restore completes", async () => {
    const { collector, tclCloud, fanHolds, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    fanHolds.set("ac1", { original_fan: 2, last_set_fan: 1 });
    await collector.acLeveler.ensureLoaded();
    const rule = acFanRule(2);
    (collector as never as { automationRules: unknown[] }).automationRules = [rule];
    getFanEnforcement(collector).set("1:ac1", { slotId: "morning", lastCommandedFan: 5, lastFanCommandAt: 0, manual: false } as never);
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1, fanSpeed: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    headroomReadings(collector, 6);
    await checkAcLeveling(collector);

    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_fan_speed", 2);
    expect(collector.acLeveler.hasFanHold("ac1")).toBe(false);
    expect(fanHolds.size).toBe(0);
    const entry = getFanEnforcement(collector).get("1:ac1") as never as { lastCommandedFan: number; manual: boolean };
    expect(entry.lastCommandedFan).toBe(2); // re-baselined — no false manual detection later
    expect(entry.manual).toBe(false);
  });

  it("treats a user fan change as the new truth: hold released, no re-reduce, shed proceeds", async () => {
    const { collector, tclCloud, actions, fanHolds, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    fanHolds.set("ac1", { original_fan: 3, last_set_fan: 1 });
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1, fanSpeed: 5 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    collector.noteUserAcFanChange("ac1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(collector.acLeveler.hasFanHold("ac1")).toBe(false);

    // Over limit with only this AC: its fan is exempt → shed instead of re-reduce
    overLimitReadings(collector, 4);
    await checkAcLeveling(collector);

    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac1", "set_fan_speed", expect.anything());
    expect(actions).toEqual([{ deviceId: "ac1", action: { power: 0 } }]);
  });

  it("releases the hold when an external fan change is observed outside settle", async () => {
    const { collector, tclCloud, fanHolds, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    fanHolds.set("ac1", { original_fan: 3, last_set_fan: 1 });
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1, fanSpeed: 4 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    headroomReadings(collector, 1);
    await checkAcLeveling(collector);

    expect(collector.acLeveler.hasFanHold("ac1")).toBe(false);
    expect(fanHolds.size).toBe(0);
    expect(tclCloud.sendControl).not.toHaveBeenCalled();
  });
});

describe("Smart AC leveling — range enforcement during a fan hold", () => {
  beforeEach(() => {
    acTimers.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T04:30:00.000Z")); // 07:30 Baghdad — morning slot active
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("strips fan_speed and turbo from re-enforcement while the leveler holds the fan", async () => {
    const { collector, tclCloud, fanHolds, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    fanHolds.set("ac1", { original_fan: 3, last_set_fan: 1 });
    await collector.acLeveler.ensureLoaded();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    tclCloud.getDeviceState.mockReturnValue({ fan_speed: 1 });
    tclCloud.computeAcDiff.mockReturnValue({ temperature: 23 });
    const rule = { ...acFanRule(2), action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3, turbo: 1 } };

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenLastCalledWith("ac1", { mode: 1, temperature: 23 });
    // Fan tracking is a no-op during the hold — no baseline, no manual flag
    expect(getFanEnforcement(collector).has("1:ac1")).toBe(false);
  });
});
