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
  const remembered = new Map<string, number>();
  const beepPrefs = new Set<string>();
  let levelingConfig: Record<string, unknown> | null = null;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("SELECT") && sql.includes("FROM ac_beep_off")) {
      return { rows: Array.from(beepPrefs).map((device_id) => ({ device_id })), rowCount: beepPrefs.size };
    }
    if (sql.includes("INSERT INTO ac_beep_off")) {
      beepPrefs.add(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM ac_beep_off")) {
      beepPrefs.delete(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
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
    if (sql.includes("SELECT") && sql.includes("FROM ac_leveling_remembered_level")) {
      return { rows: Array.from(remembered, ([device_id, level]) => ({ device_id, level })), rowCount: remembered.size };
    }
    if (sql.includes("INSERT INTO ac_leveling_remembered_level")) {
      remembered.set(String(params[0]), Number(params[1]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM ac_leveling_remembered_level")) {
      remembered.delete(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    pool: { query },
    locks,
    shed,
    fanHolds,
    remembered,
    beepPrefs,
    setLevelingConfig: (c: Record<string, unknown>) => { levelingConfig = c; },
  };
}

const LEVELING_CONFIG = {
  enabled: true,
  gridLimitAmps: 30,
  genLimitAmps: 15,
  marginAmps: 1,
  raiseBufferAmps: 0,
  comfortTargetC: 26,
  priority: ["ac1", "ac2"],
  ampModels: { ac1: { baseAmps: 2, stepAmps: 1 }, ac2: { baseAmps: 4, stepAmps: 2 } },
};

function createCollector() {
  const { pool, locks, shed, fanHolds, remembered, beepPrefs, setLevelingConfig } = createPool();
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

  return { collector, tclCloud, actions, locks, shed, fanHolds, remembered, beepPrefs, setLevelingConfig };
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

  it("resumes smart-auto fan enforcement when the user taps fan Auto", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    const rule = acFanRule(0); // slot fan = smart auto
    (collector as never as { automationRules: unknown[] }).automationRules = [rule];

    collector.noteUserAcFanChange("ac1");
    expect(getFanEnforcement(collector).get("1:ac1")?.manual).toBe(true);

    collector.noteUserAcFanAuto("ac1");
    expect(getFanEnforcement(collector).has("1:ac1")).toBe(false);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24); // delta 2.0 past low 22 → L6
    await checkAcRangeAutomation(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenLastCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6 });
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

    // First over-limit tick sheds proactively (source just became gen →
    // forceEvaluate), independent of the reactive streak gate.
    for (let i = 0; i < 5; i++) {
      collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: 16, power_1: 0, power_2: 3520 });
    }
    await checkAcLeveling(collector);

    // budget = 15 − 1 − nonAcLoad(16 − 6) = 4 < L1 sum 6 → shed ac2 (lowest priority)
    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 0 } }]);
    expect(shed.has("ac2")).toBe(true);
    expect(locks.size).toBe(0); // shed is not a manual-off lock
  });

  it("waits 5 readings for a mild over-limit (1A over) before reacting", async () => {
    const { collector, tclCloud, actions, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Prime: a single headroom reading + tick consumes the initial source-change
    // forceEvaluate so the next tick is gated purely by the reactive streak.
    headroomReadings(collector, 1);
    await checkAcLeveling(collector);
    expect(actions).toEqual([]);

    // 16A is only 1A over the 15A limit (mild) → 4 readings is not enough.
    overLimitReadings(collector, 4);
    await checkAcLeveling(collector);
    expect(actions).toEqual([]);
    expect(shed.has("ac2")).toBe(false);

    // The 5th consecutive reading completes the mild streak → shed.
    overLimitReadings(collector, 1);
    await checkAcLeveling(collector);
    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 0 } }]);
    expect(shed.has("ac2")).toBe(true);
  });

  it("sheds fast after just 2 severe over-limit readings (>1A over)", async () => {
    const { collector, tclCloud, actions, shed, locks, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Prime away the initial forceEvaluate so the streak gate is what acts.
    headroomReadings(collector, 1);
    await checkAcLeveling(collector);
    expect(actions).toEqual([]);

    // 18A is 3A over the 15A limit (severe) — only 2 readings needed.
    for (let i = 0; i < 2; i++) {
      collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: 18, power_1: 0, power_2: 3960 });
    }
    await checkAcLeveling(collector);

    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 0 } }]);
    expect(shed.has("ac2")).toBe(true);
    expect(locks.size).toBe(0);
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

  it("releases the outdoor boost at exactly threshold−1 (holds inside the band)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig({ ...LEVELING_CONFIG, levelBoosts: { ac1: { minLevel: 2, outdoorAtLeastC: 37 } } });
    await collector.acLeveler.ensureLoaded();
    const setOutdoor = (tempC: number) => {
      (collector as never as { latestWeatherRow: Record<string, unknown> }).latestWeatherRow = { temp_c: tempC };
      (collector as never as { latestWeatherTs: Date }).latestWeatherTs = new Date();
    };
    const devices = [
      { id: "ac1", name: "Abdullah", power: true, generatorMode: 2, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
    const minLevel = () => collector.acLeveler.getStatus().acs[0]?.minLevel;

    setOutdoor(38);
    collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: 4, power_1: 0, power_2: 880 });
    await checkAcLeveling(collector);
    expect(minLevel()).toBe(2);

    // 36.5° — inside the hysteresis band, the boost holds
    setOutdoor(36.5);
    collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: 4, power_1: 0, power_2: 880 });
    await checkAcLeveling(collector);
    expect(minLevel()).toBe(2);

    // Exactly 36.0° (threshold − 1) releases — used to require strictly below
    setOutdoor(36);
    collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: 4, power_1: 0, power_2: 880 });
    await checkAcLeveling(collector);
    expect(minLevel()).toBe(1);
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

describe("Smart AC leveling — warm restore after temperature cycle", () => {
  beforeEach(() => {
    acTimers.clear();
  });

  it("remembers the stable level on a temperature-cycling off and warm-restores to it on return", async () => {
    const { collector, tclCloud, actions, remembered, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();

    // Establish the leveler's stable level for ac1 = L4 (shadow-drift init on first observe).
    const onAtL4 = [{ id: "ac1", name: "Mom", power: true, generatorMode: 4, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(onAtL4);
    tclCloud.fetchDevicesLive.mockResolvedValue(onAtL4 as never);
    headroomReadings(collector, 1);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).not.toHaveBeenCalled(); // 1 reading → raise gating not met

    // Temperature drops below the range low (cool mode) → automation turns ac1 OFF.
    await setWeatherValue(collector, 20);
    await checkAcRangeAutomation(collector, acRangeRule());
    expect(actions).toEqual([{ deviceId: "ac1", action: { power: 0 } }]);
    expect(remembered.get("ac1")).toBe(4); // captured before the off

    // Leveler observes the OFF (clears its level tracking, keeps the memory).
    const off = [{ id: "ac1", name: "Mom", power: false, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(off);
    tclCloud.fetchDevicesLive.mockResolvedValue(off as never);
    headroomReadings(collector, 1);
    await checkAcLeveling(collector);
    expect(remembered.get("ac1")).toBe(4); // survives the off period

    // Room warms again — automation turns it back ON, firmware came up at L1.
    // Headroom is NOT sustained, yet the leveler jumps straight to remembered L4.
    const backOnAtL1 = [{ id: "ac1", name: "Mom", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(backOnAtL1);
    tclCloud.fetchDevicesLive.mockResolvedValue(backOnAtL1 as never);
    headroomReadings(collector, 1); // streak still < 6 (canRaise NOT met)
    await checkAcLeveling(collector);

    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 4);
    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac1", "set_generator_mode", 6);

    // Once the AC is observed at the remembered level the warm-start is consumed.
    const atL4 = [{ id: "ac1", name: "Mom", power: true, generatorMode: 4, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(atL4);
    tclCloud.fetchDevicesLive.mockResolvedValue(atL4 as never);
    headroomReadings(collector, 1);
    await checkAcLeveling(collector);
    expect(remembered.has("ac1")).toBe(false);
  });

  it("a manual power-off clears the remembered level (user intent wins)", async () => {
    const { collector, tclCloud, remembered, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();

    const onAtL4 = [{ id: "ac1", name: "Mom", power: true, generatorMode: 4, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(onAtL4);
    tclCloud.fetchDevicesLive.mockResolvedValue(onAtL4 as never);
    headroomReadings(collector, 1);
    await checkAcLeveling(collector);

    await setWeatherValue(collector, 20);
    await checkAcRangeAutomation(collector, acRangeRule());
    expect(remembered.get("ac1")).toBe(4);

    // User powers it off manually → the warm-start target is dropped.
    await collector.acLeveler.onUserPowerOff("ac1");
    expect(remembered.has("ac1")).toBe(false);
  });

  it("does not remember a floor-level (L1) stable state", async () => {
    const { collector, tclCloud, remembered, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();

    const onAtL1 = [{ id: "ac1", name: "Mom", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(onAtL1);
    tclCloud.fetchDevicesLive.mockResolvedValue(onAtL1 as never);
    headroomReadings(collector, 1);
    await checkAcLeveling(collector);

    await setWeatherValue(collector, 20);
    await checkAcRangeAutomation(collector, acRangeRule());
    // L1 is the default restore — nothing worth remembering.
    expect(remembered.has("ac1")).toBe(false);
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

function gridReadings(collector: Collector, amps: number, count: number) {
  for (let i = 0; i < count; i++) {
    collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: amps, current_2: 0, power_1: amps * 220, power_2: 0 });
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
    genReadings(collector, 16, 5);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 2);

    // 8s later the compressor hasn't responded — measured still 16A. A fresh
    // derivation would read nonAcLoad = 16−(5+6) = 5 and over-reduce Najat;
    // the frozen value (3) reproduces the already-commanded allocation.
    vi.advanceTimersByTime(8_000);
    genReadings(collector, 16, 5);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(shed.size).toBe(0);

    // Past the freeze window the persistent 16A is real — derivation resumes
    // (nonAcLoad 5 → budget 9) and the leveler reduces further.
    vi.advanceTimersByTime(8_000);
    genReadings(collector, 16, 5);
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

    genReadings(collector, 16, 5);
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

  it("keeps a freshly turned-on AC out of the established draw for the full 240s ramp", async () => {
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

    // Past 240s the compressor is established: nonAcLoad = 12 − 3 − 4 = 5
    vi.advanceTimersByTime(185_000);
    genReadings(collector, 12, 1);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().nonAcLoadAmps).toBe(5);
  });

  it("blocks the next raise for 2 min when a level raise does not draw the expected amps", async () => {
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
    // The fake headroom would now fit Abdu L2; the armed hold must block it.
    const after = [{ ...devices[0], generatorMode: 3 }, { ...devices[1] }];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 12, 4);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(collector.acLeveler.getStatus().raiseHoldRemainingMs).toBeGreaterThan(0);

    // Still held at the old 1-min mark...
    vi.advanceTimersByTime(35_000);
    genReadings(collector, 12, 4);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);

    // ...released only after the full 2-min hold expires
    vi.advanceTimersByTime(60_000);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(2);
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac2", "set_generator_mode", 2);
  });

  it("releases the hold early once the raise's expected amps actually arrive", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Najat raised L1→L3, expectation 14A armed for 2 min
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);

    // The compressor responds — measured reaches the expected 14A → hold released
    const after = [{ ...devices[0], generatorMode: 3 }, { ...devices[1] }];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 14, 4);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().raiseHoldRemainingMs).toBe(0);

    // Other household load drops → budget grows — the next raise fires well
    // inside what would have been the 2-min hold window.
    vi.advanceTimersByTime(35_000);
    genReadings(collector, 10, 6);
    await checkAcLeveling(collector);
    // budget 12: ideal najat 3 (already there) + abdu 3 → one raise goes out
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(2);
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac2", "set_generator_mode", 3);
  });

  it("holds raises for the 270s turn-on hold after an AC turn-on whose draw never arrives", async () => {
    const { collector, tclCloud, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    shed.add("ac2");
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 4, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: false, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Restore-with-reduction batch: Najat L4→L3, Abdu restored at L1
    genReadings(collector, 11, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);

    // Past the 2-min mark the measured draw never rose (compressor refuses) —
    // a turn-on holds for 270s (compressor ramp is slow), so the pending raises
    // must stay blocked.
    const after = [{ ...devices[0], generatorMode: 3 }, { ...devices[1], power: true }];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    vi.advanceTimersByTime(121_000);
    genReadings(collector, 11, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(collector.acLeveler.getStatus().raiseHoldRemainingMs).toBeGreaterThan(0);

    // After the 270s hold expires the raises resume
    vi.advanceTimersByTime(160_000);
    genReadings(collector, 11, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl.mock.calls.length).toBeGreaterThan(1);
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
    genReadings(collector, 16, 5);
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

    genReadings(collector, 16, 5);
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

describe("Smart AC leveling — raise buffer (hysteresis) stops the limit cycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Margin 0.1 → reduce only at the breaker (user intent). A 1A raise buffer
  // keeps raises a full step below it so a raised AC rests under the limit.
  const HYSTERESIS_CONFIG = { ...LEVELING_CONFIG, marginAmps: 0.1, raiseBufferAmps: 1 };

  it("settles a buffer below the breaker and won't raise into the deadband", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(HYSTERESIS_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 11A on gen → nonAcLoad 9, budget 5.9, raiseBudget 4.9. From L1 the fill
    // stops at L3 (cost 4); WITHOUT the buffer it would push to L5 right up to
    // the breaker. Sustained headroom (11 ≤ 13.9) raises Najat to L3.
    genReadings(collector, 11, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 3);

    // Shadow follows to L3; settle passes; ~13A reading releases the raise hold.
    const atL3 = [{ ...devices[0], generatorMode: 3 }];
    tclCloud.getDevices.mockReturnValue(atL3);
    tclCloud.fetchDevicesLive.mockResolvedValue(atL3 as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 13, 4);
    await checkAcLeveling(collector);
    tclCloud.sendControl.mockClear();

    // Sustained 13.5A sits in (12.9, 13.9]: full headroom builds, but the 1A
    // buffer leaves no admissible step, and 13.5 < 15 so the reduce never fires.
    // Without the buffer this raises to L4 and starts the ratchet. Dead quiet.
    genReadings(collector, 13.5, 8);
    await checkAcLeveling(collector);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).not.toHaveBeenCalled();
    // Status ideal reflects the raise-budgeted L3, not a higher unreachable level.
    expect(collector.acLeveler.getStatus().acs.find((a) => a.deviceId === "ac1")?.idealLevel).toBe(3);
  });
});

describe("Smart AC leveling — bounce detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function acStatus(collector: Collector, id: string) {
    return collector.acLeveler.getStatus().acs.find((a) => a.deviceId === id);
  }

  /**
   * Drives the canonical bounce: Abdu (ac2) raised L1→L2 on headroom, the real
   * draw overshoots the 15A gen limit, the reactive reduction pulls it back.
   * Observed cost = peak 16A − pre 12A = 4A → retry below 15−1−4 = 10A.
   */
  async function bounceAbdu(collector: Collector, tclCloud: ReturnType<typeof createCollector>["tclCloud"], devices: Record<string, unknown>[]) {
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 12A on gen → nonAcLoad 12−6=6, budget 8 → only Abdu's step (2A) fits
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 2);

    // The raise delivers MORE than estimated — 16A breaches the limit. After
    // 5 over-limit readings (mild, 1A over) the reduction undoes the raise → bounce recorded.
    const after = devices.map((d) => (d.id === "ac2" ? { ...d, generatorMode: 2 } : { ...d }));
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 16, 5);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac2", "set_generator_mode", 1);

    // Shadow follows the reduction back to L1
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
    vi.advanceTimersByTime(31_000);
  }

  it("caps a bounced raise and stays quiet instead of looping", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 23, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    await bounceAbdu(collector, tclCloud, devices);
    expect(acStatus(collector, "ac2")).toMatchObject({ bounceCap: 1, bounceRetryBelowAmps: 10 });

    // Headroom rebuilds exactly like before the bounce — the old behavior
    // would re-raise Abdu here (raise → over-limit → reduce, forever).
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(2); // raise + reduce only
    expect(acStatus(collector, "ac2")?.bounceCap).toBe(1);

    // The load drops enough to absorb the OBSERVED 4A cost (6+4 ≤ 14) — the
    // cap clears and the retry goes straight to the new ideal.
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 6, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac2")?.bounceCap).toBeNull();
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac2", "set_generator_mode", 3);
  });

  it("attributes a reduction as a bounce past the raise hold, up to the bounce window", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 23, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Raise Abdu L1→L2 on headroom.
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 2);

    // Shadow follows to L2.
    const after = devices.map((d) => (d.id === "ac2" ? { ...d, generatorMode: 2 } : { ...d }));
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);

    // 150s later — PAST the 120s raise hold but inside the 300s bounce window —
    // the raise's amps finally breach the limit and the reactive reduction undoes
    // it. Before the window was decoupled this recorded NO bounce (cycle period >
    // hold) and the same AC was re-raised next round.
    vi.advanceTimersByTime(150_000);
    genReadings(collector, 16, 5);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac2", "set_generator_mode", 1);
    expect(acStatus(collector, "ac2")?.bounceCap).toBe(1);
  });

  it("explores the other AC while the bounced one is capped", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    // Both rooms hot — Abdu (29°) outranks Najat (28°) for the first raise
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 29, mode: 1 },
    ];
    await bounceAbdu(collector, tclCloud, devices);

    // Same headroom again: 12 + 4A observed cost > 14 keeps Abdu capped, so
    // the budget goes to Najat instead — other options explored first.
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac2")?.bounceCap).toBe(1);
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac1", "set_generator_mode", 3);
  });

  it("clears the bounce cap on a power cycle", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 23, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    await bounceAbdu(collector, tclCloud, devices);
    expect(acStatus(collector, "ac2")?.bounceCap).toBe(1);

    const off = [devices[0], { ...devices[1], power: false }];
    tclCloud.getDevices.mockReturnValue(off);
    tclCloud.fetchDevicesLive.mockResolvedValue(off as never);
    genReadings(collector, 8, 1);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac2")?.bounceCap).toBeNull();
  });

  it("clears all bounce records when the power source changes", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 23, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    await bounceAbdu(collector, tclCloud, devices);
    expect(acStatus(collector, "ac2")?.bounceCap).toBe(1);

    // Changeover to grid — gen bounce evidence is meaningless there
    collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 10, current_2: 0, power_1: 2200, power_2: 0 });
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac2")?.bounceCap).toBeNull();
  });

  it("blocks re-restoring a shed AC whose restore bounced, until the load drops", async () => {
    const { collector, tclCloud, actions, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    shed.add("ac2");
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 23, mode: 1 },
      { id: "ac2", name: "Abdu", power: false, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 8A on gen → nonAcLoad 6, budget 8 → Abdu's floor (4A) fits → restore
    genReadings(collector, 8, 6);
    await checkAcLeveling(collector);
    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 1, generator_mode: 1 } }]);

    // Past the 240s compressor ramp the real draw breaches the limit → re-shed
    // within the restore's bounce window = restore bounce (observed cost 16−8=8,
    // clamped to floor 4 + 3 = 7A → retry below 15−1−7 = 7A).
    const on = [devices[0], { ...devices[1], power: true }];
    tclCloud.getDevices.mockReturnValue(on);
    tclCloud.fetchDevicesLive.mockResolvedValue(on as never);
    vi.advanceTimersByTime(241_000);
    genReadings(collector, 16, 5);
    await checkAcLeveling(collector);
    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual({ deviceId: "ac2", action: { power: 0 } });
    expect(shed.has("ac2")).toBe(true);
    expect(acStatus(collector, "ac2")).toMatchObject({ restoreBlocked: true, bounceRetryBelowAmps: 7 });

    // The same headroom that triggered the first restore returns — blocked now
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 8, 6);
    await checkAcLeveling(collector);
    expect(actions).toHaveLength(2);

    // Load drops below the observed-cost threshold (6+7 ≤ 14) → restore retried
    genReadings(collector, 6, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac2")?.restoreBlocked).toBe(false);
    expect(actions).toHaveLength(3);
    expect(actions[2]).toEqual({ deviceId: "ac2", action: { power: 1, generator_mode: 1 } });
  });
});

describe("Smart AC leveling — confirmation-gated drift + source change", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function acStatus(collector: Collector, id: string) {
    return collector.acLeveler.getStatus().acs.find((a) => a.deviceId === id);
  }

  it("does not cap an AC when a raise's shadow lags past the settle window", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 12A on gen → nonAcLoad 10, budget 4 → Najat raised L1→L3 (est 4 fits).
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 3);

    // The shadow NEVER reflects the raise (lag / firmware ignored the write).
    // 31s later, PAST the 30s settle window, the OLD detector would read
    // observed(1) < commanded(3) and stamp a false manual cap L1. It must not.
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac1")?.manualCap).toBeNull();

    // Past the raise hold the leveler simply re-issues the unconfirmed raise.
    vi.advanceTimersByTime(125_000);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac1")?.manualCap).toBeNull();
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac1", "set_generator_mode", 3);
  });

  it("caps after the shadow confirms a raise and the user then reduces", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 3);

    // Shadow follows to L3 → the raise is confirmed (no cap).
    const atL3 = [{ ...devices[0], generatorMode: 3 }];
    tclCloud.getDevices.mockReturnValue(atL3);
    tclCloud.fetchDevicesLive.mockResolvedValue(atL3 as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac1")?.manualCap).toBeNull();

    // Now the user reduces L3→L2 on the remote with no command in flight — a
    // genuine manual change off the confirmed baseline → cap.
    const reduced = [{ ...devices[0], generatorMode: 2 }];
    tclCloud.getDevices.mockReturnValue(reduced);
    tclCloud.fetchDevicesLive.mockResolvedValue(reduced as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac1")?.manualCap).toBe(2);
  });

  it("does not set a manual target from a stale-high shadow after a reduction", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 4, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 16A over the 15A gen limit → Abdu reduced L3→L2.
    genReadings(collector, 16, 5);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 2);

    // The shadow still reports the OLD L3 (reduce hasn't propagated). Past the
    // settle window the OLD detector would read observed(3) > commanded(2) and
    // stamp a false manual TARGET L3. It must not.
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 13, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac2")?.manualTarget).toBeNull();
    expect(acStatus(collector, "ac2")?.manualCap).toBeNull();
  });

  it("releases a manual cap when the source moves onto Grid, but keeps it onto Generator", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const onGen = [{ id: "ac1", name: "Najat", power: true, generatorMode: 3, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(onGen);
    tclCloud.fetchDevicesLive.mockResolvedValue(onGen as never);

    // Establish on gen, then the user reduces to L1 → manual cap.
    genReadings(collector, 9, 6);
    await checkAcLeveling(collector);
    await collector.acLeveler.onUserGenLevel("ac1", 1);
    const atL1 = [{ ...onGen[0], generatorMode: 1 }];
    tclCloud.getDevices.mockReturnValue(atL1);
    tclCloud.fetchDevicesLive.mockResolvedValue(atL1 as never);
    genReadings(collector, 9, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac1")?.manualCap).toBe(1);

    // Changeover to Grid (15A→30A budget) — the cap no longer applies.
    gridReadings(collector, 9, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac1")?.manualCap).toBeNull();
  });

  it("keeps a manual cap when the source moves onto Generator", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const onGrid = [{ id: "ac1", name: "Najat", power: true, generatorMode: 3, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(onGrid);
    tclCloud.fetchDevicesLive.mockResolvedValue(onGrid as never);

    // Establish on grid, then the user reduces to L1 → manual cap.
    gridReadings(collector, 9, 6);
    await checkAcLeveling(collector);
    await collector.acLeveler.onUserGenLevel("ac1", 1);
    const atL1 = [{ ...onGrid[0], generatorMode: 1 }];
    tclCloud.getDevices.mockReturnValue(atL1);
    tclCloud.fetchDevicesLive.mockResolvedValue(atL1 as never);
    gridReadings(collector, 9, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac1")?.manualCap).toBe(1);

    // Changeover to Generator (tighter budget) — the cap is kept.
    genReadings(collector, 9, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac1")?.manualCap).toBe(1);
  });

  it("re-arms the compressor ramp window on a Gen↔Grid changeover", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    // Satisfied (24°<26° target) → capped at L1, so the leveler never raises
    // and never reduces — isolating the nonAcLoad derivation.
    const devices = [{ id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 24, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // none→gen is the ESP resuming, NOT a restart → Najat is established and its
    // est IS subtracted: nonAcLoad = 8 − est(L1=2) = 6.
    genReadings(collector, 8, 6);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().nonAcLoadAmps).toBe(6);

    // A true Gen→Grid changeover restarts the compressor → ramp re-armed → est
    // stays OUT of the derivation → nonAcLoad jumps back to the full 8.
    gridReadings(collector, 8, 6);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().nonAcLoadAmps).toBe(8);
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

    overLimitReadings(collector, 5);
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

    overLimitReadings(collector, 5);
    await checkAcLeveling(collector); // fan reduce + streak reset

    overLimitReadings(collector, 4);
    await checkAcLeveling(collector);
    expect(actions).toEqual([]); // 4 < 5 — fresh window not complete

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
    overLimitReadings(collector, 5);
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

async function checkAcBeep(collector: Collector) {
  await (collector as never as { checkAcBeepEnforcement: () => Promise<void> }).checkAcBeepEnforcement();
}

describe("AC beep-off enforcement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function beepingAc(overrides: Record<string, unknown> = {}) {
    return [{ id: "ac1", name: "Najat", power: true, beep: true, ...overrides }];
  }

  function setDevices(tclCloud: ReturnType<typeof createCollector>["tclCloud"], devices: Record<string, unknown>[]) {
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never); // the 30s-gated refresh returns the same state
  }

  it("records the pref on UI beep-off and re-sends beep off when it drifts back on", async () => {
    const { collector, tclCloud, beepPrefs } = createCollector();
    setDevices(tclCloud, beepingAc());

    collector.noteUserAcBeep("ac1", false);
    await vi.advanceTimersByTimeAsync(0); // flush the async DB write
    expect(beepPrefs.has("ac1")).toBe(true);

    // Right after the UI toggle the command was already sent — no immediate re-send
    await checkAcBeep(collector);
    expect(tclCloud.sendControl).not.toHaveBeenCalled();

    // Past the settle window the beep is still reported on → enforce
    vi.advanceTimersByTime(31_000);
    await checkAcBeep(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_beep", 0);
  });

  it("respects the per-device resend cooldown", async () => {
    const { collector, tclCloud, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    setDevices(tclCloud, beepingAc());

    await checkAcBeep(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);

    await checkAcBeep(collector); // immediate next tick — still settling
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(31_000); // beep STILL on after the cooldown → re-send
    await checkAcBeep(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(2);
  });

  it("UI beep-on clears the pref and stops enforcement", async () => {
    const { collector, tclCloud, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    setDevices(tclCloud, beepingAc());

    collector.noteUserAcBeep("ac1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(beepPrefs.has("ac1")).toBe(false);

    vi.advanceTimersByTime(31_000);
    await checkAcBeep(collector);
    expect(tclCloud.sendControl).not.toHaveBeenCalled();
  });

  it("skips devices that are off or already silent", async () => {
    const { collector, tclCloud, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    beepPrefs.add("ac2");
    setDevices(tclCloud, [
      { id: "ac1", name: "Najat", power: false, beep: true },
      { id: "ac2", name: "Abdu", power: true, beep: false },
    ]);

    await checkAcBeep(collector);
    expect(tclCloud.sendControl).not.toHaveBeenCalled();
  });

  it("enforces after a server restart from the persisted pref (live fetch path)", async () => {
    const { collector, tclCloud, beepPrefs } = createCollector();
    beepPrefs.add("ac1"); // pre-seeded row, no UI hook this session
    tclCloud.getDevices.mockReturnValue([]); // cold cache → gated live fetch
    tclCloud.fetchDevicesLive.mockResolvedValue(beepingAc() as never);

    await checkAcBeep(collector);
    expect(tclCloud.fetchDevicesLive).toHaveBeenCalled();
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_beep", 0);
  });

  it("stands down while calibration is active", async () => {
    const { collector, tclCloud, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    setDevices(tclCloud, beepingAc());
    vi.spyOn(collector.acCalibrator, "isActive").mockReturnValue(true);

    await checkAcBeep(collector);
    expect(tclCloud.sendControl).not.toHaveBeenCalled();
  });
});
