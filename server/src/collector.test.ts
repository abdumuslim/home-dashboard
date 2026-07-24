import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Config } from "./config.js";
import { Collector } from "./collector.js";
import { acTimers } from "./routes.js";
import { UNREACHABLE_LEVEL_SENDS, SETTLE_MS, AC_RAMP_MS, ENFORCE_GEN_FLOORS_MAX_MS } from "./ac-leveling.js";
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
  observedOffLocks: true,
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

  it("clears the lock only after the off is observed, then the AC is seen back on (genuine remote-on)", async () => {
    const { collector, tclCloud, actions } = createCollector();
    await (collector as never as { recordAcManualOff: (id: string, reason: string) => Promise<void> }).recordAcManualOff("ac1", "test");
    (collector as never as { acManualOffLockTimes: Map<string, number> }).acManualOffLockTimes.set("ac1", Date.now() - 20_000);

    // 1) The off first propagates to the shadow — this confirms the lock took
    //    effect but does NOT turn the AC on (lock holds, no command).
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: false }]);
    await setWeatherValue(collector, 27);
    await checkAcRangeAutomation(collector, acRangeRule());
    await expect((collector as never as { isAcManualOffLocked: (id: string) => Promise<boolean> }).isAcManualOffLocked("ac1")).resolves.toBe(true);
    expect(actions).toEqual([]);

    // 2) Now the user turns it back on via the remote → the lock clears and the
    //    active range profile is adopted.
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    tclCloud.computeAcDiff.mockReturnValue({ temperature: 23 });
    await checkAcRangeAutomation(collector, acRangeRule());

    await expect((collector as never as { isAcManualOffLocked: (id: string) => Promise<boolean> }).isAcManualOffLocked("ac1")).resolves.toBe(false);
    expect(actions).toEqual([{ deviceId: "ac1", action: { temperature: 23 } }]);
  });

  it("does not clear a manual-off lock from an on-read when the off was never observed (stale/flappy shadow, 32A grid incident)", async () => {
    const { collector, tclCloud, actions } = createCollector();
    await (collector as never as { recordAcManualOff: (id: string, reason: string) => Promise<void> }).recordAcManualOff("ac1", "test");
    // Grace has long elapsed, but the shadow reported "on" the WHOLE time — the
    // user's off never propagated (or the TCL shadow flapped). The 15s grace
    // alone used to let this clear the sacred lock, and the range then turned
    // the AC back on ~60s after the user turned it off (2026-06-19 incident).
    (collector as never as { acManualOffLockTimes: Map<string, number> }).acManualOffLockTimes.set("ac1", Date.now() - 60_000);
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    tclCloud.computeAcDiff.mockReturnValue({ temperature: 23 });

    await setWeatherValue(collector, 27);
    await checkAcRangeAutomation(collector, acRangeRule());

    await expect((collector as never as { isAcManualOffLocked: (id: string) => Promise<boolean> }).isAcManualOffLocked("ac1")).resolves.toBe(true);
    expect(actions).toEqual([]);
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

      // Smart-auto fan: delta 25.5−22=3.5 past the morning slot's low → L7
      expect(actions).toEqual([{ deviceId: "ac1", action: { power: 1, mode: 1, temperature: 23, fan_speed: 7 } }]);
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

describe("AC range dead-zone adoption + turn-off re-fire (regressions)", () => {
  beforeEach(() => {
    acTimers.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T04:30:00.000Z")); // 07:30 Baghdad — morning slot active
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("regression: dead-zone adoption persists the triggered status", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);

    await setWeatherValue(collector, 23); // dead zone (22 < 23 < 26)
    await checkAcRangeAutomation(collector, acRangeRule());

    const state = (collector as never as { automationState: Map<number, { status: string }> }).automationState.get(1);
    expect(state?.status).toBe("triggered");
  });

  it("regression: manual fan override survives dead-zone adoption and the triggered path", async () => {
    const { collector, tclCloud } = createCollector();
    const rule = acFanRule(2);
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    getFanEnforcement(collector).set("1:ac1", {
      slotId: "morning", lastCommandedFan: 4, lastFanCommandAt: Date.now(), manual: true,
    } as never);

    await setWeatherValue(collector, 23); // dead zone of the morning slot (22–25)
    await checkAcRangeAutomation(collector, rule); // dead-zone adoption → triggered
    expect(getFanEnforcement(collector).get("1:ac1")?.manual).toBe(true);

    await checkAcRangeAutomation(collector, rule); // triggered re-enforcement
    expect(getFanEnforcement(collector).get("1:ac1")?.manual).toBe(true);
  });

  it("regression: range turn-off does not double-fire while the shadow lags", async () => {
    const { collector, tclCloud, actions } = createCollector();
    const remember = vi.spyOn(collector.acLeveler, "rememberStableLevel");
    setTriggered(collector, 1);
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    const offs = () => actions.filter((a) => (a.action as { power?: number }).power === 0);

    await setWeatherValue(collector, 21); // ≤ low limit → turn off
    await checkAcRangeAutomation(collector, acRangeRule());
    expect(offs()).toHaveLength(1);
    expect(remember).toHaveBeenCalledTimes(1);

    // 7s later the shadow still reads ON (power cache TTL is 5s) — must not re-fire
    vi.advanceTimersByTime(7_000);
    await checkAcRangeAutomation(collector, acRangeRule());
    expect(offs()).toHaveLength(1);
    expect(remember).toHaveBeenCalledTimes(1);

    // past the grace a genuinely still-ON AC is turned off again
    vi.advanceTimersByTime(9_000);
    await checkAcRangeAutomation(collector, acRangeRule());
    expect(offs()).toHaveLength(2);
  });
});

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

  it("uses smart auto when the slot has no fan override (preset fan ignored)", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, acFanRule()); // preset fan 3, no slot fan

    // 2026-06-11: the fan is ALWAYS smart auto unless the slot fixes 1–7 —
    // delta 24−22=2.0 → L6, the preset's fan 3 no longer drives enforcement.
    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6 });
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

  it("treats an observed fan 0 as a firmware reset, not a manual change", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    tclCloud.getDeviceState.mockReturnValue({ fan_speed: 2 });

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, acFanRule(2)); // baseline adopted (observed == desired 2)

    // TCL firmware resets the fan to built-in auto (0) after a power-loss
    // restart (changeovers) — automations never command 0, so a 0 observation
    // must NOT suspend enforcement (live 2026-06-11: Abdu & Abdullah stuck at
    // "A" after every changeover).
    vi.setSystemTime(new Date("2026-05-20T04:30:20.000Z")); // +20s — past the settle window
    tclCloud.getDeviceState.mockReturnValue({ fan_speed: 0 });
    await setWeatherValue(collector, 24);
    await checkAcRangeAutomation(collector, acFanRule(2));

    expect(getFanEnforcement(collector).get("1:ac1")?.manual).toBe(false);
    expect(tclCloud.computeAcDiff).toHaveBeenLastCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 2 });
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

    // The all-day slot has no fan override → smart auto (delta 24−20=4 → L7)
    expect(tclCloud.computeAcDiff).toHaveBeenLastCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 7 });
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
  // Through the serialized wrapper, NOT the private checkAcLeveling directly:
  // severe readings fed via setLatestPower fire the urgent-leveling dep, and a
  // direct call would interleave with that in-flight urgent pass at await
  // points (double-shedding nondeterministically — exactly what the guard
  // exists to prevent in production).
  await (collector as never as { runLevelingCheck: () => Promise<void> }).runLevelingCheck();
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

    // fan = smart auto (delta 24−22=2.0 → L6); preset fan no longer enforced
    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6 });
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

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6, generator_mode: 2 });
  });

  it("drops generator_mode from re-enforcement after a manual gen change on an opted-out AC (2026-06-21)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    const rule = { ...acRangeRule(), smart_leveling: false, action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3, generator_mode: 2 } };

    // User just set ac1's gen level by hand → manual wins: the opted-out range
    // must NOT re-enforce its generator_mode (no slamming the manual level back).
    void collector.onUserAcGenLevel("ac1", 3);
    await checkAcRangeAutomation(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6 });
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

    // 16A = +1A over (mild → 1 point each). 5 readings empty the 5-point bucket.
    // All-mild empty → the allocator reduce path acts.
    for (let i = 0; i < 5; i++) {
      collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: 16, power_1: 0, power_2: 3520 });
    }
    await checkAcLeveling(collector);

    // Both at L1 floors, no reducible fans → sheds ac2 (lowest priority)
    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 0 } }]);
    expect(shed.has("ac2")).toBe(true);
    expect(locks.size).toBe(0); // shed is not a manual-off lock
  });

  it("waits for the over-limit bucket to drain (5 mild readings) before reacting", async () => {
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

    // 15.5A is only 0.5A over the 15A limit (mild → 1 point each). 4 readings
    // leave 1 point in the bucket — not yet empty.
    overLimitReadings(collector, 4);
    await checkAcLeveling(collector);
    expect(actions).toEqual([]);
    expect(shed.has("ac2")).toBe(false);

    // The 5th mild reading empties the bucket → act (all at floors → shed ac2).
    overLimitReadings(collector, 1);
    await checkAcLeveling(collector);
    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 0 } }]);
    expect(shed.has("ac2")).toBe(true);
  });

  it("sheds fast after just 2 severe over-limit readings (≥1A over)", async () => {
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

  it("raises a gen AC one level per tick instead of straight to the fitted ideal", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    // Abdu alone on gen at L1, hot — budget fits L3, but a gen raise must climb
    // ONE step (confirm the surge on the meter) before the next.
    const devices = [
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    genReadings(collector, 4, 6); // sustained headroom on gen → raise gate met
    await checkAcLeveling(collector);

    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 2);
    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac2", "set_generator_mode", 3);
  });

  it("strips a gen raise whose model-projected total exceeds the limit (2026-07-23 double-L3 trip)", async () => {
    // The live incident: Abdu at L3, Najat L2→L3 admitted on a lagging meter
    // reading ~10A while the model already predicted 16.9A on the 15A gen —
    // shipped anyway, breaker tripped 68s later. The physics envelope must
    // strip the raise the meter cannot veto.
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig({
      ...LEVELING_CONFIG,
      // Live-shaped gen models: ac1 (1-ton) 2.3+2 → 6.3 @L3; ac2 (2-ton) 4.3+2.5 → 9.3 @L3.
      ampModels: { ac1: { baseAmps: 2.3, stepAmps: 2 }, ac2: { baseAmps: 4.3, stepAmps: 2.5 } },
    });
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 2, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Meter shows plenty of room (10A on 15A) — the surge gate would admit the
    // raise (10 + 2 ≤ 14), but 9.3 + 6.3 = 15.6 > 15 projected steady state.
    primeGenSource(collector); // steady-state gen (not a cold-start floors entry)
    genReadings(collector, 10, 6);
    await checkAcLeveling(collector);

    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac1", "set_generator_mode", 3);
  });

  it("the same raise ships once the projected total fits (envelope is not a blanket freeze)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    // Small models: ac1 4 @L3 + ac2 8 @L3 = 12 ≤ 15 — projection fits, raise proceeds.
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 2, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    primeGenSource(collector);
    genReadings(collector, 10, 6);
    await checkAcLeveling(collector);

    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 3);
  });

  it("on grid jumps straight to the meter-anchored ideal in one batch — no one-step pacing (2026-06-21)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 4A on a 30A grid → ~25A of real headroom on the meter → Abdu jumps L1→L3 in
    // ONE batch. The 06-19 one-step grid cap is gone (user, 2026-06-21): the
    // meter-anchored fill bounds the ideal to real headroom, so artificial pacing
    // only made grid crawl while ~11A sat unused.
    gridReadings(collector, 4, 6);
    await checkAcLeveling(collector);

    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 3);
  });

  it("grid raises straight to the fitted ideal when maxRaiseStepGrid is loosened", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig({ ...LEVELING_CONFIG, maxRaiseStepGrid: 3 });
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    gridReadings(collector, 4, 6);
    await checkAcLeveling(collector);

    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 3);
  });

  it("on grid the meter-anchored fill self-limits near the limit — won't seat BOTH at L3 (32A guard, 2026-06-21)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    // Grid limit lowered to 15 so the meter rides near it: the meter-anchored
    // admission — not the retired one-step cap — is now the 32A guard. Seating
    // both ACs at L3 would add ~4A and overshoot, so the fill must refuse.
    setLevelingConfig({ ...LEVELING_CONFIG, gridLimitAmps: 15 });
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 12A measured on a 15A grid (bufferedLimit 14) → only ~2A of room. The meter
    // gate seats Najat at L3 but keeps Abdu at L1; the projected meter never tops
    // the buffered limit, so the home can't overshoot the way it did at 32A.
    gridReadings(collector, 12, 6);
    await checkAcLeveling(collector);

    const calls = tclCloud.sendControl.mock.calls as unknown as unknown[][];
    const reachedL3 = ["ac1", "ac2"].filter((id) =>
      calls.some((c) => c[0] === id && c[1] === "set_generator_mode" && c[2] === 3),
    );
    expect(reachedL3.length).toBeLessThan(2);
  });

  it("reduces levels instantly when an AC turns on near the limit", async () => {
    const { collector, tclCloud, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    primeGenSource(collector); // already on gen — not a cold start (Fix 1)

    // Tick 1: only Najat running at L6 (est 7A), generator at 12A — under the
    // 15A limit but close to it. Nothing to do.
    const before = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 6, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
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

    // Tick 2: Abdu turns ON while measured is still 12A — the compressor
    // hasn't ramped, so there are ZERO over-limit readings. The ramping AC
    // gets FLOOR credit only (4A at L1, not its full estimate), so
    // nonAcLoad = 12 − 7 − 4 = 1 → budget 13 → fitted ideal { ac1: 4, ac2: 3 }
    // and Najat must be reduced L6→L4 immediately (power-flip forceEvaluate).
    const after = [{ ...before[0] }, { ...before[1], power: true }];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    await checkAcLeveling(collector);

    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 4);
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

  it("restores a second shed AC during the first restore's hold when the expectation leaves room", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
    try {
      const { collector, tclCloud, actions, shed, setLevelingConfig } = createCollector();
      setLevelingConfig(LEVELING_CONFIG);
      shed.add("ac1");
      shed.add("ac2");
      await collector.acLeveler.ensureLoaded();
      const devices = [
        { id: "ac1", name: "Najat", power: false, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 29, mode: 1 },
        { id: "ac2", name: "Abdu", power: false, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      ];
      tclCloud.getDevices.mockReturnValue(devices);
      tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

      // Headroom on gen → Najat (most needy, Δ3) restores first and arms the
      // 270s turn-on hold with expectation 4A non-AC + 2A floor = 6A.
      genReadings(collector, 4, 6);
      await checkAcLeveling(collector);
      expect(actions).toEqual([{ deviceId: "ac1", action: { power: 1, generator_mode: 1 } }]);

      // 31s later (past settle, hold still ~4 min out): Abdu's restore fits
      // the hold's own expectation (6A + 4A floor ≤ 14A buffered limit) — it
      // must NOT wait out the hold (that wait cost Abdu ~20 min, 2026-06-11).
      vi.advanceTimersByTime(31_000);
      genReadings(collector, 4, 6);
      await checkAcLeveling(collector);

      expect(actions).toEqual([
        { deviceId: "ac1", action: { power: 1, generator_mode: 1 } },
        { deviceId: "ac2", action: { power: 1, generator_mode: 1 } },
      ]);
      expect(shed.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

    primeGenSource(collector); // already on gen — not a cold start (Fix 1)
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
    // Headroom is NOT sustained, yet the leveler jumps straight to remembered L4
    // (warm restore is exempt from the gen one-step pacing — it returns to a
    // known-stable level, not an exploratory climb).
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
    primeGenSource(collector); // already on gen — not a cold start (Fix 1)

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

// 15.5A on the 15A gen limit: over, but UNDER the severe boundary (≥ limit+1A
// since 2026-06-12) — exercises the MILD 5-reading staged path. Severe-path
// tests feed ≥16A explicitly.
function overLimitReadings(collector: Collector, count: number) {
  for (let i = 0; i < count; i++) {
    collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: 0, current_2: 15.5, power_1: 0, power_2: 3410 });
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

/**
 * Seat the leveler as ALREADY running on gen so a fixture's first reading is not
 * a cold-start none→gen transition — which now floors every above-floor AC until
 * the shadow confirms (Fix 1, 2026-07-10). These suites exercise steady-state
 * gen behavior, not cold start (which has its own regression describe below).
 * Pokes the private `lastSource`, the same private-access pattern other suites
 * use (e.g. `automationState`). Leaves every other field at its clean initial
 * value — identical to the post-source-change reset, minus the one-shot
 * forceEvaluate, which none of these tests depend on (they act via the over-limit
 * bucket, a sustained headroom streak, or a power-flip).
 */
function primeGenSource(collector: Collector) {
  (collector.acLeveler as never as { lastSource: string }).lastSource = "gen";
}

function gridReadings(collector: Collector, amps: number, count: number) {
  for (let i = 0; i < count; i++) {
    collector.setLatestPower({ ts: new Date().toISOString(), voltage: 220, current_1: amps, current_2: 0, power_1: amps * 220, power_2: 0 });
  }
}

describe("Smart AC leveling — gen changeover enforces floors until confirmed", () => {
  // Crossing the 30s settle (to read the real shadow) and the 240s ramp needs
  // controllable time. The Collector schedules no intervals in its constructor,
  // so advancing the fake clock only bumps Date.now()/settle/ramp — no loops fire.
  beforeEach(() => {
    acTimers.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T10:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const onGrid = (gen: number) => [
    { id: "ac1", name: "Najat", power: true, generatorMode: gen, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    { id: "ac2", name: "Abdu", power: true, generatorMode: gen, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
  ];
  const sentFloor = (tcl: { sendControl: { mock: { calls: unknown[][] } } }, id: string) =>
    tcl.sendControl.mock.calls.some((c) => c[0] === id && c[1] === "set_generator_mode" && c[2] === 1);

  it("re-asserts the floor-down each tick until the shadow confirms, then stops", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();

    // Both managed ACs ON at L3, running on grid (establishes grid as prior source).
    let devices = onGrid(3);
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
    gridReadings(collector, 10, 6);
    await checkAcLeveling(collector);

    // Direct grid→gen changeover. First gen tick floors BOTH to L1 (forceEvaluate)
    // and must NOT climb (startAtFloors skips the fill).
    tclCloud.sendControl.mockClear();
    genReadings(collector, 12, 4);
    await checkAcLeveling(collector);
    expect(sentFloor(tclCloud, "ac1")).toBe(true);
    expect(sentFloor(tclCloud, "ac2")).toBe(true);
    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac1", "set_generator_mode", 2);
    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac2", "set_generator_mode", 2);

    // The firmware DIDN'T apply — the shadow still reads L3. Cross the settle window
    // and tick again: the leveler must RE-ASSERT the floor (today it goes quiet).
    tclCloud.sendControl.mockClear();
    vi.advanceTimersByTime(SETTLE_MS + 1000);
    genReadings(collector, 12, 4);
    await checkAcLeveling(collector);
    expect(sentFloor(tclCloud, "ac1")).toBe(true);
    expect(sentFloor(tclCloud, "ac2")).toBe(true);

    // Now the shadow confirms L1. Cross the ramp + settle: enforcement clears, so the
    // floor is no longer re-sent (the units are genuinely at floor).
    devices = onGrid(1);
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
    tclCloud.sendControl.mockClear();
    vi.advanceTimersByTime(AC_RAMP_MS + SETTLE_MS + 1000);
    genReadings(collector, 8, 4);
    await checkAcLeveling(collector);
    expect(sentFloor(tclCloud, "ac1")).toBe(false);
    expect(sentFloor(tclCloud, "ac2")).toBe(false);
  });

  it("stops enforcing floors once the user changes a level manually (manual wins)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();

    const devices = onGrid(3);
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
    gridReadings(collector, 10, 6);
    await checkAcLeveling(collector);

    // grid→gen → enforcement armed, floors issued.
    genReadings(collector, 12, 4);
    await checkAcLeveling(collector);

    // User intervenes (manual gen change) → enforcement clears for all ACs. The
    // shadow still reads L3 (not applied), but the leveler must NOT force the floor
    // back down on ac1 after the manual override.
    await collector.acLeveler.onUserGenLevel("ac2", 2);
    tclCloud.sendControl.mockClear();
    vi.advanceTimersByTime(SETTLE_MS + 1000);
    genReadings(collector, 12, 4);
    await checkAcLeveling(collector);
    expect(sentFloor(tclCloud, "ac1")).toBe(false);
  });
});

describe("Smart AC leveling — cold start into gen enforces floors (deploy-mid-gen incident, 2026-07-10)", () => {
  // A deploy recreated the container while the house ran on generator. The fresh
  // leveler saw a none→gen transition (prevSource "none"), which used to skip the
  // gen floors-first pass entirely, so an AC adopted at L3 kept its cap and the
  // compressor surged past the breaker. Floors must now be enforced on ANY
  // transition into gen, including from "none".
  beforeEach(() => {
    acTimers.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T03:46:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const sentFloor = (tcl: { sendControl: { mock: { calls: unknown[][] } } }, id: string) =>
    tcl.sendControl.mock.calls.some((c) => c[0] === id && c[1] === "set_generator_mode" && c[2] === 1);
  const sentLevel = (tcl: { sendControl: { mock: { calls: unknown[][] } } }, level: number) =>
    tcl.sendControl.mock.calls.some((c) => c[1] === "set_generator_mode" && c[2] === level);

  it("floors an AC adopted at L3 on the FIRST tick after none→gen, re-asserts until confirmed, then resumes the climb", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();

    // Fresh leveler (lastSource "none") — no priming: this IS the cold start.
    let devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // First gen tick floors BOTH to L1 and must NOT climb (startAtFloors skips the fill).
    genReadings(collector, 12, 4);
    await checkAcLeveling(collector);
    expect(sentFloor(tclCloud, "ac1")).toBe(true);
    expect(sentFloor(tclCloud, "ac2")).toBe(true);
    expect(sentLevel(tclCloud, 2)).toBe(false);
    expect(sentLevel(tclCloud, 3)).toBe(false);

    // Firmware hasn't applied — shadow still L3. Cross settle → re-assert the floor.
    tclCloud.sendControl.mockClear();
    vi.advanceTimersByTime(SETTLE_MS + 1000);
    genReadings(collector, 12, 4);
    await checkAcLeveling(collector);
    expect(sentFloor(tclCloud, "ac1")).toBe(true);
    expect(sentFloor(tclCloud, "ac2")).toBe(true);

    // Shadow confirms L1. Cross ramp+settle: enforcement clears (floors no longer
    // re-sent) and, with sustained metered headroom, the one-step climb resumes.
    devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
    tclCloud.sendControl.mockClear();
    vi.advanceTimersByTime(AC_RAMP_MS + SETTLE_MS + 1000);
    genReadings(collector, 8, 6);
    await checkAcLeveling(collector);
    expect(sentFloor(tclCloud, "ac1")).toBe(false);
    expect(sentFloor(tclCloud, "ac2")).toBe(false);
    expect(sentLevel(tclCloud, 2)).toBe(true); // one-step climb resumed
  });

  it("arms and self-clears with ZERO commands when the AC is already at its floor (steady cold start)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Already at L1 → enforcement arms and self-clears the same tick, no floor
    // command (this is why most existing gen tests are unaffected once primed).
    genReadings(collector, 8, 1);
    await checkAcLeveling(collector);
    expect(sentFloor(tclCloud, "ac1")).toBe(false);
  });
});

describe("Smart AC leveling — power-collapse (trip) guard", () => {
  beforeEach(() => {
    acTimers.clear();
  });

  it("does not restore a shed AC on the low readings of a current collapse (probable trip)", async () => {
    const { collector, tclCloud, actions, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    shed.add("ac1");
    await collector.acLeveler.ensureLoaded();
    const off = [{ id: "ac1", name: "Najat", power: false, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 29, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(off);
    tclCloud.fetchDevicesLive.mockResolvedValue(off as never);

    // Home riding the 15A gen in the margin band (14<m≤15 → no headroom) — ac1 stays shed.
    genReadings(collector, 14.5, 4);
    await checkAcLeveling(collector);
    expect(actions).toEqual([]);

    // Breaker trips: current collapses ~14.5A → 3.7A and stays low. Those low
    // readings would otherwise build the headroom streak and restore ac1 into a
    // dead line (live 2026-06-13: leveler raised Najat reading 3.7A as free budget).
    genReadings(collector, 3.7, 5);
    await checkAcLeveling(collector);

    expect(actions).toEqual([]);          // frozen — no restore into the collapse
    expect(shed.has("ac1")).toBe(true);   // still shed
  });

  it("resumes restores once the line recovers from a collapse (freeze is not permanent)", async () => {
    const { collector, tclCloud, actions, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    shed.add("ac1");
    await collector.acLeveler.ensureLoaded();
    const off = [{ id: "ac1", name: "Najat", power: false, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 29, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(off);
    tclCloud.fetchDevicesLive.mockResolvedValue(off as never);

    genReadings(collector, 14.5, 4);   // riding near the limit
    genReadings(collector, 3.7, 4);    // trip → collapse latched, raises frozen
    await checkAcLeveling(collector);
    expect(actions).toEqual([]);

    // Power returns near the pre-collapse level → collapse clears; sustained
    // headroom then rebuilds the streak and the shed AC restores.
    genReadings(collector, 12.7, 1);   // recovery reading (≥ preMedian − gap)
    genReadings(collector, 11, 4);     // headroom (≤ limit−margin 14) rebuilds the streak
    await checkAcLeveling(collector);

    expect(actions).toEqual([{ deviceId: "ac1", action: { power: 1, generator_mode: 1 } }]);
    expect(shed.has("ac1")).toBe(false);
  });

  it("does not mint a manual intent from a stuck shadow while a collapse is latched, and resumes after recovery (2026-07-10)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    primeGenSource(collector); // already on gen — isolate the collapse/drift behavior

    const acAt = (level: number) => [
      { id: "ac1", name: "Najat", power: true, generatorMode: level, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    const manualIntent = () => {
      const s = collector.acLeveler.getStatus().acs.find((a) => a.deviceId === "ac1");
      return { cap: s?.manualCap ?? null, target: s?.manualTarget ?? null };
    };

    // Confirm ac1 at L2 riding the margin band (no raise/reduce).
    tclCloud.getDevices.mockReturnValue(acAt(2));
    tclCloud.fetchDevicesLive.mockResolvedValue(acAt(2) as never);
    genReadings(collector, 14.5, 6);
    await checkAcLeveling(collector);

    // Breaker trips: current collapses 14.5A → 3.2A → latch. The dead line's
    // shadow then reads a STUCK L3 (an emergency's L3→L2 never landed). Pre-fix
    // this minted a false "external gen increment → target L3" from a corpse.
    genReadings(collector, 3.2, 2);
    tclCloud.getDevices.mockReturnValue(acAt(3));
    tclCloud.fetchDevicesLive.mockResolvedValue(acAt(3) as never);
    await checkAcLeveling(collector);
    expect(manualIntent()).toEqual({ cap: null, target: null }); // Fix 4: no intent while latched

    // Line recovers near the pre-collapse level → collapse clears (shadow re-adopted at L3).
    genReadings(collector, 14, 6);
    await checkAcLeveling(collector);

    // A GENUINE manual reduction now (L3→L1) is detected again — drift resumed.
    tclCloud.getDevices.mockReturnValue(acAt(1));
    tclCloud.fetchDevicesLive.mockResolvedValue(acAt(1) as never);
    genReadings(collector, 12, 1);
    await checkAcLeveling(collector);
    expect(manualIntent().cap).toBe(1);
  });
});

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
    primeGenSource(collector); // already on gen — not a cold start (Fix 1)
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
    primeGenSource(collector); // already on gen — not a cold start (Fix 1)
    const devices = twoRunningAcs();
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 15.5A (mild) over the 15A gen limit → nonAcLoad 15.5−13=2.5, budget 11.5
    // → fitted ideal Najat L4 + Abdu L2 → Abdu L3→L2
    genReadings(collector, 15.5, 5);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 2);

    // 8s later the compressor hasn't responded — measured still 15.5A. A fresh
    // derivation would read nonAcLoad = 15.5−(5+6) = 4.5 and over-reduce Najat;
    // the frozen value (2.5) reproduces the already-commanded allocation.
    vi.advanceTimersByTime(8_000);
    genReadings(collector, 15.5, 5);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(shed.size).toBe(0);

    // Past the freeze window the persistent 15.5A is real — derivation resumes
    // (nonAcLoad 4.5 → budget 9.5) and the leveler reduces further.
    vi.advanceTimersByTime(8_000);
    genReadings(collector, 15.5, 5);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(2);
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac1", "set_generator_mode", 2);
  });

  it("reports expectedAmps on the command tick and grades it after effects settle", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    primeGenSource(collector); // already on gen — not a cold start (Fix 1)
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

  it("credits a ramping AC at its floor draw for the full 240s ramp (full estimate after)", async () => {
    const { collector, tclCloud, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    primeGenSource(collector); // already on gen — not a cold start (Fix 1)
    const before = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 6, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: false, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(before);
    tclCloud.fetchDevicesLive.mockResolvedValue(before as never);
    genReadings(collector, 12, 3);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).not.toHaveBeenCalled();

    // Abdu turns ON (shadow at L3) near the limit. His ramping draw gets FLOOR
    // credit (4A at L1), not zero and not the full L3 estimate (8A):
    // nonAcLoad = 12 − Najat@L6 (7) − 4 = 1 → budget 13 → ideal { ac1: 4,
    // ac2: 3 } → instant proactive reduction of Najat L6→L4.
    const after = [{ ...before[0] }, { ...before[1], power: true }];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 4);

    // 60s in (past the old 30s window): Abdu is still ramping at L3 — still
    // only floor credit, so nonAcLoad = 12 − Najat@L4 (5) − 4 = 3.
    const settled = [{ ...after[0], generatorMode: 4 }, { ...after[1] }];
    tclCloud.getDevices.mockReturnValue(settled);
    tclCloud.fetchDevicesLive.mockResolvedValue(settled as never);
    vi.advanceTimersByTime(60_000);
    genReadings(collector, 12, 1);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().nonAcLoadAmps).toBe(3);
    expect(shed.size).toBe(0);

    // Past 240s the compressor is established at its full L3 estimate (8A):
    // nonAcLoad = max(0, 12 − 5 − 8) = 0
    vi.advanceTimersByTime(185_000);
    genReadings(collector, 12, 1);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().nonAcLoadAmps).toBe(0);
  });

  it("blocks the next raise for 2 min when a level raise does not draw the expected amps", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    // Single Abdu (step 2A): a one-step gen raise here is +2A, so a flat meter
    // can't auto-satisfy the hold (a +1A Najat step would early-release at once).
    const devices = [
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 12A on gen → nonAcLoad 8, budget 6 → Abdu raised one step L1→L2 (+2A expected 14)
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 2);

    // Settle passes but measured never rises — the cap rose, the draw didn't.
    // The fake headroom would now fit L3; the armed hold must block it.
    const after = [{ ...devices[0], generatorMode: 2 }];
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

    // ...released only after the full 2-min hold expires → next step L2→L3
    vi.advanceTimersByTime(60_000);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(2);
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac2", "set_generator_mode", 3);
  });

  it("releases the hold early once the raise's expected amps actually arrive", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    // Single Abdu (step 2A) so the +2A expectation is meaningful on a flat meter.
    const devices = [
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Abdu raised one step L1→L2, expectation 14A armed for 2 min
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);

    // The compressor responds — measured reaches the expected 14A → hold released
    const after = [{ ...devices[0], generatorMode: 2 }];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 14, 4);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().raiseHoldRemainingMs).toBe(0);

    // Other household load drops → budget grows — the next step (L2→L3) fires
    // well inside what would have been the 2-min hold window.
    vi.advanceTimersByTime(35_000);
    genReadings(collector, 10, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(2);
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac2", "set_generator_mode", 3);
  });

  it("releases the hold early on provable headroom even when the raise under-delivers (Fix A)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    // Single Najat (step 1A): a low-expected raise with ample room to the limit.
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 10A on gen → nonAcLoad 8, Najat raised one step L1→L2 (expected 11A), hold armed.
    genReadings(collector, 10, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 2);

    // The cap rose but the draw didn't (meter even drifts down to 9A) — the
    // expected 11A never "arrives" (9 < 11 − 1 threshold). Pre-fix this sat the
    // full 2-min hold. Now: expected 11A + the next 1A step ≤ 14A buffered limit
    // with a sustained headroom streak → provable-headroom release, next step fires.
    const after = [{ ...devices[0], generatorMode: 2 }];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 9, 6);
    await checkAcLeveling(collector);
    // The old hold released early on provable headroom and the next step fired
    // well inside the 2-min window (which then re-arms its own fresh hold).
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(2);
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac1", "set_generator_mode", 3);
  });

  it("learns a higher raise surge from a clean over-delivering raise and gates the next step (Fix C)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    // Single Najat (model step 1A). A clean raise (no over-limit, no bounce)
    // whose real cost is 4A must teach the gate — the bounce path never sees it.
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 8A on gen → nonAcLoad 6, Najat raised L1→L2 (model expects +1 → 9A), hold armed.
    genReadings(collector, 8, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 2);

    // The real cost was +4A (meter → 12A, still well under the 15A limit so no
    // bounce). Grading learns observedRaiseCost[ac1] ≈ 4. The next step L2→L3 is
    // now surge-charged 4A: nonAcLoad 9, budget 5 → 3 + 4 = 7 > 5 → BLOCKED.
    // (With only the 1A model step it would have been 3 + 1 = 4 ≤ 5 and fired.)
    const after = [{ ...devices[0], generatorMode: 2 }];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    // Hold released (12 ≥ 9 − 1 arrived), surge learned, next step held back.
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
  });

  it("on grid a learned raise surge caps the meter-anchored ideal (2026-06-21)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    // Grid limit lowered to 15 so the meter sits near it and a surge can bite.
    // Abdu (model step 2A): a clean raise that really cost +2.5A teaches the gate
    // so a later L2→L3 that the static 2A step WOULD admit is blocked.
    setLevelingConfig({ ...LEVELING_CONFIG, gridLimitAmps: 15 });
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 12A on a 15A grid (bufferedLimit 14): L1→L2 fits (12+2=14) but L2→L3 (16)
    // does not → Abdu raised L1→L2 only, hold armed.
    gridReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 2);
    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac2", "set_generator_mode", 3);

    // The real cost was +2.5A (meter → 14.5A, still under 15A so no bounce).
    // Grading learns observedRaiseCost[ac2] ≈ 2.5.
    const after = [{ ...devices[0], generatorMode: 2 }];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    vi.advanceTimersByTime(31_000);
    gridReadings(collector, 14.5, 6);
    await checkAcLeveling(collector);

    // Load drops back to 12A. With ONLY the 2A model step, L2→L3 (12+2=14) would
    // fire; the learned 2.5A surge makes it 14.5 > 14 → BLOCKED. No further raise.
    vi.advanceTimersByTime(35_000);
    gridReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac2", "set_generator_mode", 3);
  });

  it("holds raises for the 270s turn-on hold after an AC turn-on whose draw never arrives", async () => {
    const { collector, tclCloud, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    shed.add("ac2");
    await collector.acLeveler.ensureLoaded();
    primeGenSource(collector); // already on gen — not a cold start (Fix 1)
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
    primeGenSource(collector); // already on gen — not a cold start (Fix 1)
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

  it("on a grid→gen changeover drops managed ACs to FLOORS, not the model-fitted gen ideal (2026-06-21)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Establish on grid (both at L3, ample headroom) so the leveler's source = grid.
    gridReadings(collector, 18, 6);
    await checkAcLeveling(collector);
    tclCloud.sendControl.mockClear();

    // Changeover to gen: the first tick holds everyone at the FLOOR (L1) and lets
    // the meter-confirmed gate climb back — instead of seating them at the
    // gen-budget-fitted L2, whose hot-compressor surge tripped the generator live.
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 1);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 1);
    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac1", "set_generator_mode", 2);
    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac2", "set_generator_mode", 2);
  });

  it("does NOT revert a manual grid raise when the real meter has headroom (2026-06-21)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    // Grid limit 12: the model SUM of the two ACs (Najat L3 4A + Abdu L3 8A = 12A,
    // with nonAcLoad clamped to 0) projects 12A > 11A and WOULD revert — but the
    // real meter reads 8A, ~3A under the limit, so the meter projection (8+2=10)
    // must let the raise through. Hard-pin the user's level.
    setLevelingConfig({ ...LEVELING_CONFIG, gridLimitAmps: 12 });
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 2, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 4 readings → meter trusted for the projection, but streak < 6 so the leveler
    // itself doesn't pre-raise Abdu (keeps the manual path the thing under test).
    gridReadings(collector, 8, 4);
    await checkAcLeveling(collector);

    const result = await collector.acLeveler.onUserGenLevel("ac2", 3);
    expect(result.reverted).toBe(false);
  });

  it("reverts a manual gen raise when the real meter would breach the limit", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Meter rides at 14A on a 15A gen (limit − margin = 14). Raising Abdu L1→L2
    // adds its +2A model step → 16A > 14A → reverted.
    genReadings(collector, 14, 6);
    await checkAcLeveling(collector);

    const result = await collector.acLeveler.onUserGenLevel("ac2", 2);
    expect(result.reverted).toBe(true);
    expect(result.level).toBe(1);
  });

  it("keeps a learned gen raise surge across a gen→grid→gen changeover (per-source, 2026-06-21)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig({ ...LEVELING_CONFIG, genLimitAmps: 15 });
    await collector.acLeveler.ensureLoaded();
    const abdu = { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 };
    tclCloud.getDevices.mockReturnValue([abdu]);
    tclCloud.fetchDevicesLive.mockResolvedValue([abdu] as never);

    // Gen: Abdu L1→L2 (12+2=14 fits, 14+2=16 doesn't), real cost +2.5A → learns ~2.5.
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 2);
    const atL2 = [{ ...abdu, generatorMode: 2 }];
    tclCloud.getDevices.mockReturnValue(atL2);
    tclCloud.fetchDevicesLive.mockResolvedValue(atL2 as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 14.5, 6);
    await checkAcLeveling(collector);

    // Round-trip the source (gen→grid→gen). Pre-2026-06-21 this WIPED the learned
    // surge; now it persists per source.
    gridReadings(collector, 10, 6);
    await checkAcLeveling(collector);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    tclCloud.sendControl.mockClear();

    // Back on gen at 12A with Abdu at L2: the static 2A step would admit L2→L3
    // (12+2=14) but the persisted ~2.5A surge (12+2.5=14.5 > 14) keeps it blocked.
    vi.advanceTimersByTime(35_000);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac2", "set_generator_mode", 3);
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

    // 11A on gen → nonAcLoad 9, budget 5.9, raiseBudget 4.9. The buffer caps the
    // fitted target at L3 (cost 4); WITHOUT it the fill would push to L5 right up
    // to the breaker. The COMMAND paces one step (L1→L2); the status ideal still
    // shows the buffer-fitted L3.
    genReadings(collector, 11, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 2);
    expect(collector.acLeveler.getStatus().acs.find((a) => a.deviceId === "ac1")?.idealLevel).toBe(3);

    // Shadow follows to L2; the raise hold expires (draw flat) → next step L2→L3.
    const atL2 = [{ ...devices[0], generatorMode: 2 }];
    tclCloud.getDevices.mockReturnValue(atL2);
    tclCloud.fetchDevicesLive.mockResolvedValue(atL2 as never);
    vi.advanceTimersByTime(121_000);
    genReadings(collector, 11, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac1", "set_generator_mode", 3);

    // Shadow follows to L3; settle/hold pass.
    const atL3 = [{ ...devices[0], generatorMode: 3 }];
    tclCloud.getDevices.mockReturnValue(atL3);
    tclCloud.fetchDevicesLive.mockResolvedValue(atL3 as never);
    vi.advanceTimersByTime(121_000);
    genReadings(collector, 13, 4);
    await checkAcLeveling(collector);
    tclCloud.sendControl.mockClear();

    // Sustained 13.5A sits in (12.9, 13.9]: full headroom builds, but with Najat
    // at L3 the 1A buffer leaves no admissible step, and 13.5 < 15 so the reduce
    // never fires. Without the buffer this raises to L4 and starts the ratchet.
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

    // The raise delivers MORE than estimated — 16A breaches the limit (severe
    // at exactly +1A since 2026-06-12): the meter-sized emergency cut (1A over
    // + 1A margin = 2A = Abdu's step) undoes the raise → bounce recorded.
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
    // cap clears and the retry climbs one step (gen one-step raise).
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 6, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac2")?.bounceCap).toBeNull();
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac2", "set_generator_mode", 2);
  });

  it("keeps the bounce on a MOMENTARY load drop — only sustained headroom clears it (anti-cycle)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 23, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    await bounceAbdu(collector, tclCloud, devices);
    expect(acStatus(collector, "ac2")?.bounceCap).toBe(1);

    // The load drops below the bounce state, but only briefly (3 readings <
    // RAISE_STREAK) — exactly what shedding a DIFFERENT AC does before it is
    // restored. The cap must NOT clear on this momentary dip (the live cycle:
    // a shed dropped the total, the bounce cleared, the AC re-raised, re-bounced).
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 6, 3);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac2")?.bounceCap).toBe(1);

    // Sustained headroom (a full streak) finally clears it.
    genReadings(collector, 6, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac2")?.bounceCap).toBeNull();
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
    // the budget goes to Najat instead — other options explored first (one step).
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac2")?.bounceCap).toBe(1);
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac1", "set_generator_mode", 2);
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
    // Both rooms equally satisfied: with need-based shed protection neither is
    // protected by being cooler, so the priority tiebreak re-sheds the non-top
    // bouncer (ac2 Abdu) when its restore breaches — exercising the bounce block.
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 23, mode: 1 },
      { id: "ac2", name: "Abdu", power: false, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 23, mode: 1 },
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

    // 12A on gen → nonAcLoad 10, budget 4 → Najat raised one step L1→L2.
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 2);

    // The shadow NEVER reflects the raise (lag / firmware ignored the write).
    // 31s later, PAST the 30s settle window, the OLD detector would read
    // observed(1) < commanded(2) and stamp a false manual cap L1. It must not.
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac1")?.manualCap).toBeNull();

    // Past the raise hold the leveler simply re-issues the unconfirmed raise.
    vi.advanceTimersByTime(125_000);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac1")?.manualCap).toBeNull();
    expect(tclCloud.sendControl).toHaveBeenLastCalledWith("ac1", "set_generator_mode", 2);
  });

  it("caps after the shadow confirms a raise and the user then reduces", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    // Abdu (step 2A): the +2A one-step raise's hold won't auto-release on a flat
    // meter, so the AC stays at the confirmed L2 for the user to then reduce.
    const devices = [
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 2);

    // Shadow follows to L2 → the raise is confirmed (no cap); the hold keeps it
    // from climbing further while the draw is flat.
    const atL2 = [{ ...devices[0], generatorMode: 2 }];
    tclCloud.getDevices.mockReturnValue(atL2);
    tclCloud.fetchDevicesLive.mockResolvedValue(atL2 as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac2")?.manualCap).toBeNull();

    // Now the user reduces L2→L1 on the remote with no command in flight — a
    // genuine manual change off the confirmed baseline → cap.
    const reduced = [{ ...devices[0], generatorMode: 1 }];
    tclCloud.getDevices.mockReturnValue(reduced);
    tclCloud.fetchDevicesLive.mockResolvedValue(reduced as never);
    vi.advanceTimersByTime(31_000);
    genReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac2")?.manualCap).toBe(1);
  });

  it("does not set a manual target from a stale-high shadow after a reduction", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    primeGenSource(collector); // already on gen — not a cold start (Fix 1)
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
    primeGenSource(collector); // already on gen — not a cold start (Fix 1)
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

  it("clamps a stale-client gen level above the device max (TCL removed Najat's 4–6)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [{ id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    gridReadings(collector, 9, 6);
    await checkAcLeveling(collector);
    // An old cached client bundle posts L6. The intent must record at the max
    // (3) and pendingLevel must be a level the shadow can actually confirm —
    // an unconfirmable pending wedges drift bookkeeping.
    await collector.acLeveler.onUserGenLevel("ac1", 6);
    const pending = (collector.acLeveler as unknown as { pendingLevel: Map<string, number> }).pendingLevel;
    expect(pending.get("ac1")).toBe(3);

    // The (cloud-clamped) command lands at 3 — re-confirms with no drift intent.
    devices[0].generatorMode = 3;
    vi.advanceTimersByTime(31_000);
    gridReadings(collector, 9, 6);
    await checkAcLeveling(collector);
    expect(acStatus(collector, "ac1")?.manualTarget).toBe(3);
    expect(acStatus(collector, "ac1")?.manualCap).toBeNull();
    expect(acStatus(collector, "ac1")?.unreachableLevels).toEqual([]);
  });

  it("re-arms the compressor ramp window on a Gen↔Grid changeover", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    // L3 with the gen budget exactly fitting L3 (nonAcLoad 10 → budget 4 =
    // floor 2A + two 1A steps) — the fitted ideal equals the current level,
    // so the gen tick stays quiet and isolates the nonAcLoad derivation.
    const devices = [{ id: "ac1", name: "Najat", power: true, generatorMode: 3, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // none→gen is the ESP resuming, NOT a restart → Najat is established and
    // its full L3 estimate IS subtracted: nonAcLoad = 14 − est(L3=4) = 10.
    genReadings(collector, 14, 6);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().nonAcLoadAmps).toBe(10);

    // A true Gen→Grid changeover restarts the compressor → ramp re-armed →
    // the ramping AC drops to FLOOR credit (L1 = 2A, not its L3 estimate):
    // nonAcLoad = 14 − 2 = 12 (pre-2026-06-11 zero-credit read the full 14).
    gridReadings(collector, 14, 6);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().nonAcLoadAmps).toBe(12);
  });

  it("re-adopts the drift baseline after a changeover instead of stamping a false cap", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 3, maxGeneratorLevel: 6, currentTemp: 23, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // On gen, the shadow is confirmed at L3 (first observation adopts it).
    genReadings(collector, 8, 6);
    await checkAcLeveling(collector);

    // Changeover to grid restarts the compressor and the firmware comes back
    // at L1. The pre-changeover L3 baseline was cleared with the source — the
    // first grid observation re-adopts L1, it must NOT read as a manual
    // reduction (false `cap L1`).
    devices[0].generatorMode = 1;
    vi.advanceTimersByTime(11_000);
    gridReadings(collector, 8, 6);
    await checkAcLeveling(collector);

    const ac = collector.acLeveler.getStatus().acs.find((a) => a.deviceId === "ac1");
    expect(ac?.manualCap).toBeNull();
    expect(ac?.manualTarget).toBeNull();
  });
});

describe("Smart AC leveling — unreachable levels (Najat L6 firmware)", () => {
  beforeEach(() => {
    acTimers.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const genCalls = (tclCloud: { sendControl: { mock: { calls: unknown[][] } } }, level: number) =>
    tclCloud.sendControl.mock.calls.filter((c) => c[1] === "set_generator_mode" && c[2] === level).length;

  function najatAtZero() {
    return [{ id: "ac1", name: "Najat", power: true, generatorMode: 0, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 }];
  }

  /** Drive `n` post-settle ticks with the shadow pinned (each re-sends the unconfirmed level). */
  async function resendTicks(collector: Collector, n: number) {
    for (let i = 0; i < n; i++) {
      vi.advanceTimersByTime(31_000);
      gridReadings(collector, 12, 6);
      await checkAcLeveling(collector);
    }
  }

  it("regression: marks a never-confirmed level unreachable after 3 sends and falls back (Najat L6)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = najatAtZero();
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Level-0 correction targets the fitted ideal L6; the shadow never applies
    // it (stays 0) — live 2026-06-09 this re-sent L6 every ~35s for 2 hours.
    gridReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(genCalls(tclCloud, 6)).toBe(1);

    await resendTicks(collector, UNREACHABLE_LEVEL_SENDS - 1); // remaining sends → marked unreachable
    expect(genCalls(tclCloud, 6)).toBe(UNREACHABLE_LEVEL_SENDS);

    // Fallback: the next correction targets L5, never L6 again.
    await resendTicks(collector, 1);
    expect(genCalls(tclCloud, 6)).toBe(UNREACHABLE_LEVEL_SENDS);
    expect(genCalls(tclCloud, 5)).toBe(1);

    // The shadow applies L5 → confirmed at the top of the next tick → quiet.
    devices[0].generatorMode = 5;
    await resendTicks(collector, 2);
    expect(genCalls(tclCloud, 5)).toBe(1);
    expect(genCalls(tclCloud, 6)).toBe(UNREACHABLE_LEVEL_SENDS);
  });

  it("un-marks the level if the firmware confirms it after all", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = najatAtZero();
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    gridReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    await resendTicks(collector, UNREACHABLE_LEVEL_SENDS - 1); // full send budget → marked
    expect(genCalls(tclCloud, 6)).toBe(UNREACHABLE_LEVEL_SENDS);

    // The pending L6 lands late — confirm un-marks it; no L5 fallback ships.
    devices[0].generatorMode = 6;
    await resendTicks(collector, 2);
    expect(genCalls(tclCloud, 5)).toBe(0);
    expect(genCalls(tclCloud, 6)).toBe(UNREACHABLE_LEVEL_SENDS);
  });

  it("un-marks a level that confirms after the fallback moved on (no false manual target)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = najatAtZero();
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    gridReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    await resendTicks(collector, UNREACHABLE_LEVEL_SENDS - 1); // full send budget → L6 marked unreachable
    expect(genCalls(tclCloud, 6)).toBe(UNREACHABLE_LEVEL_SENDS);
    await resendTicks(collector, 1); // fallback L5 ships — pending is now 5
    expect(genCalls(tclCloud, 5)).toBe(1);

    // The OLD L6 finally lands (live 2026-06-11: Najat's L4 landed 6s after
    // the 3rd send marked it). obs ≠ pending — the pre-fix drift branch read
    // this as a manual "target L6". It must un-mark instead.
    devices[0].generatorMode = 6;
    await resendTicks(collector, 1);

    const ac = collector.acLeveler.getStatus().acs.find((a) => a.deviceId === "ac1");
    expect(ac?.manualTarget).toBeNull();
    expect(ac?.manualCap).toBeNull();
    expect(ac?.unreachableLevels).toEqual([]);
  });

  it("regression: a stale mark expires after the 60-min safety window and the level is re-probed", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = najatAtZero();
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    gridReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    await resendTicks(collector, UNREACHABLE_LEVEL_SENDS - 1); // full send budget → L6 marked unreachable
    expect(genCalls(tclCloud, 6)).toBe(UNREACHABLE_LEVEL_SENDS);
    await resendTicks(collector, 1); // fallback L5 ships
    devices[0].generatorMode = 5; // shadow confirms L5 → system goes quiet
    await resendTicks(collector, 1);
    expect(genCalls(tclCloud, 6)).toBe(UNREACHABLE_LEVEL_SENDS);

    // Live 2026-06-11: junk marks minted during a morning shadow-stuck-at-0
    // episode capped Najat at L3 on grid ALL DAY with ~19A of budget free.
    // After the safety expiry the mark drops and the level is re-probed.
    vi.advanceTimersByTime(60 * 60_000 + 1000);
    gridReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    const ac = collector.acLeveler.getStatus().acs.find((a) => a.deviceId === "ac1");
    expect(ac?.unreachableLevels).toEqual([]);
    expect(genCalls(tclCloud, 6)).toBe(UNREACHABLE_LEVEL_SENDS + 1); // re-probe shipped
  });

  it("marks survive a power cycle; an explicit manual gen change clears them", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = najatAtZero();
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    gridReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    await resendTicks(collector, UNREACHABLE_LEVEL_SENDS - 1); // L6 marked unreachable
    expect(genCalls(tclCloud, 6)).toBe(UNREACHABLE_LEVEL_SENDS);

    // Power cycle: off tick, then back on at level 0.
    devices[0].power = false;
    await resendTicks(collector, 1);
    devices[0].power = true;
    devices[0].generatorMode = 0;
    await resendTicks(collector, 1);
    // The correction after the cycle targets L5 — the mark survived.
    expect(genCalls(tclCloud, 6)).toBe(UNREACHABLE_LEVEL_SENDS);
    expect(genCalls(tclCloud, 5)).toBeGreaterThanOrEqual(1);

    // Shadow settles at L5; the user then explicitly sets L6 — a fresh probe.
    devices[0].generatorMode = 5;
    await resendTicks(collector, 1);
    await collector.acLeveler.onUserGenLevel("ac1", 6);
    await resendTicks(collector, 1);
    expect(genCalls(tclCloud, 6)).toBeGreaterThanOrEqual(UNREACHABLE_LEVEL_SENDS + 1); // L6 attempted again
  });

  it("regression: a shadow snapping to 0 never records a manual target (31A grid incident)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    // This 6-level firmware regression is about manual-target recording, not
    // raise pacing — loosen the grid step cap so the L2→L6 setup raise still
    // lands in one batch (one-step grid pacing arrived 2026-06-19).
    setLevelingConfig({ ...LEVELING_CONFIG, maxRaiseStepGrid: 6 });
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 2, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Confirmed at L2, then raised toward L6 (command in flight).
    gridReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 6);

    // The firmware resets to 0 instead of applying L6. Live 2026-06-10 this was
    // stamped as "external gen increment observed → target L7" while the AC ran
    // unrestricted at 31A. It must be silent — no manual intent of any kind.
    devices[0].generatorMode = 0;
    vi.advanceTimersByTime(31_000);
    gridReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    const ac = collector.acLeveler.getStatus().acs.find((a) => a.deviceId === "ac1");
    expect(ac?.manualTarget).toBeNull();
    expect(ac?.manualCap).toBeNull();

    // The never-level-0 rule keeps re-capping and the unreachable counting
    // still completes (pendingLevel survives the 0-observation).
    await resendTicks(collector, UNREACHABLE_LEVEL_SENDS - 1);
    expect(genCalls(tclCloud, 6)).toBe(UNREACHABLE_LEVEL_SENDS);
    await resendTicks(collector, 1);
    expect(genCalls(tclCloud, 5)).toBeGreaterThanOrEqual(1);
  });

  it("regression: a fluttering target cannot evade unreachable detection (per-level send counts)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = najatAtZero();
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // The active slot cap alternates L6/L5 every tick (stand-in for a budget
    // flutter) while the shadow never applies anything — with a same-level-only
    // counter neither level would ever reach 3 sends.
    const capRule = (cap: number) => ({
      ...acRangeRule(),
      range_slots: [
        { id: "default", type: "all_day", threshold_low: 22, threshold: 26, gen_level: cap },
      ] satisfies AutomationRangeSlot[],
    });
    await setWeatherValue(collector, 28);
    for (let i = 0; i < UNREACHABLE_LEVEL_SENDS * 2 + 1; i++) {
      (collector as never as { automationRules: unknown[] }).automationRules = [capRule(i % 2 === 0 ? 6 : 5)];
      vi.advanceTimersByTime(31_000);
      gridReadings(collector, 12, 6);
      await checkAcLeveling(collector);
    }

    // Both alternating levels get marked (full send budget each) and the
    // controller falls through to L4 instead of re-sending 6/5 forever.
    expect(genCalls(tclCloud, 6)).toBeLessThanOrEqual(UNREACHABLE_LEVEL_SENDS);
    expect(genCalls(tclCloud, 5)).toBeLessThanOrEqual(UNREACHABLE_LEVEL_SENDS);
    expect(genCalls(tclCloud, 4)).toBeGreaterThanOrEqual(1);
  });

  it("regression: warm-restore memory survives an observed level 0 (not 'reached')", async () => {
    const { collector, tclCloud, remembered, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();

    // Stable at a confirmed L4 → automation temperature-cycles it off.
    const onAtL4 = [{ id: "ac1", name: "Najat", power: true, generatorMode: 4, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(onAtL4);
    tclCloud.fetchDevicesLive.mockResolvedValue(onAtL4 as never);
    gridReadings(collector, 12, 1);
    await checkAcLeveling(collector);
    await setWeatherValue(collector, 20);
    await checkAcRangeAutomation(collector, acRangeRule());
    expect(remembered.get("ac1")).toBe(4);

    // Back ON with the shadow reporting 0 (firmware reset / never-applied level
    // — Najat's normal state). rank(0) = max+1 read as "reached" and erased
    // the memory ~300ms after every remember (live 2026-06-09). It must survive.
    const backOnAtZero = [{ id: "ac1", name: "Najat", power: true, generatorMode: 0, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(backOnAtZero);
    tclCloud.fetchDevicesLive.mockResolvedValue(backOnAtZero as never);
    vi.advanceTimersByTime(11_000);
    gridReadings(collector, 12, 1);
    await checkAcLeveling(collector);
    expect(remembered.get("ac1")).toBe(4);

    // Once the AC is genuinely observed at/above L4 the memory is consumed.
    const atL4 = [{ id: "ac1", name: "Najat", power: true, generatorMode: 4, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 }];
    tclCloud.getDevices.mockReturnValue(atL4);
    tclCloud.fetchDevicesLive.mockResolvedValue(atL4 as never);
    vi.advanceTimersByTime(31_000);
    gridReadings(collector, 12, 1);
    await checkAcLeveling(collector);
    expect(remembered.has("ac1")).toBe(false);
  });
});

describe("Smart AC leveling — fan command confirm-or-resend + fast fan pacing", () => {
  beforeEach(() => {
    acTimers.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const fanCalls = (tclCloud: { sendControl: { mock: { calls: unknown[][] } } }, fan: number) =>
    tclCloud.sendControl.mock.calls.filter((c) => c[1] === "set_fan_speed" && c[2] === fan).length;

  it("regression: a lagging fan shadow is re-sent (bounded), never misread as a manual change", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1, fanSpeed: 7 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Over the gen limit with floors not fitting → fan reduce 7→1 (last try
    // before shed). The shadow never applies it — Najat's normal behavior.
    overLimitReadings(collector, 5);
    await checkAcLeveling(collector);
    expect(fanCalls(tclCloud, 1)).toBe(1);
    expect(collector.acLeveler.hasFanHold("ac1")).toBe(true);

    // 11s later (past the 10s fan settle, before the 15s resend spacing):
    // shadow still 7 — the OLD detector released the hold here as an
    // "external fan change" and exempted the AC (live 2026-06-09).
    vi.advanceTimersByTime(11_000);
    genReadings(collector, 14.5, 1); // dead band — no allocator action
    await checkAcLeveling(collector);
    expect(collector.acLeveler.hasFanHold("ac1")).toBe(true);
    expect(fanCalls(tclCloud, 1)).toBe(1); // spacing not reached yet

    // Past the 15s spacing → re-send #1, then #2; then it stops (bounded).
    vi.advanceTimersByTime(5_000);
    genReadings(collector, 14.5, 1);
    await checkAcLeveling(collector);
    expect(fanCalls(tclCloud, 1)).toBe(2);

    vi.advanceTimersByTime(16_000);
    genReadings(collector, 14.5, 1);
    await checkAcLeveling(collector);
    expect(fanCalls(tclCloud, 1)).toBe(3);

    vi.advanceTimersByTime(16_000);
    genReadings(collector, 14.5, 1);
    await checkAcLeveling(collector);
    expect(fanCalls(tclCloud, 1)).toBe(3); // resends exhausted, hold kept
    expect(collector.acLeveler.hasFanHold("ac1")).toBe(true);

    // The command finally lands → confirmed; a later move to a fan we never
    // commanded is a genuine user change → release.
    devices[0].fanSpeed = 1;
    vi.advanceTimersByTime(11_000);
    genReadings(collector, 14.5, 1);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.hasFanHold("ac1")).toBe(true);

    devices[0].fanSpeed = 4;
    vi.advanceTimersByTime(11_000);
    genReadings(collector, 14.5, 1);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.hasFanHold("ac1")).toBe(false);
  });

  it("fan-only batches settle in ~10s, arm no raise hold, and restore one AC per gated action", async () => {
    const { collector, tclCloud, fanHolds, setLevelingConfig } = createCollector();
    setLevelingConfig({ ...LEVELING_CONFIG, priority: ["ac1", "ac2"] });
    fanHolds.set("ac1", { original_fan: 4, last_set_fan: 1 });
    fanHolds.set("ac2", { original_fan: 5, last_set_fan: 1 });
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 23, mode: 1, fanSpeed: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 23, mode: 1, fanSpeed: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Headroom → highest-priority hold restored in ONE jump (1→4, no steps).
    headroomReadings(collector, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_fan_speed", 4);
    expect(collector.acLeveler.hasFanHold("ac1")).toBe(false);
    expect(collector.acLeveler.getStatus().raiseHoldRemainingMs).toBe(0); // fan raises arm no hold

    // Only ~11s later (NOT 30s) the next held AC restores — fan-only settle.
    devices[0].fanSpeed = 4;
    vi.advanceTimersByTime(11_000);
    headroomReadings(collector, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_fan_speed", 5);
    expect(collector.acLeveler.hasFanHold("ac2")).toBe(false);
    expect(collector.acLeveler.getStatus().raiseHoldRemainingMs).toBe(0);
  });
});

describe("Per-range-slot generator level (gen_level)", () => {
  beforeEach(() => {
    acTimers.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function slotCapRule(genLevel: number | undefined, over: Record<string, unknown> = {}) {
    return {
      ...acRangeRule(),
      range_slots: [
        { id: "default", type: "all_day", threshold_low: 22, threshold: 26, ...(genLevel != null ? { gen_level: genLevel } : {}) },
      ] satisfies AutomationRangeSlot[],
      ...over,
    };
  }

  it("hard-caps the leveler at the active slot's gen level", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    (collector as never as { automationRules: unknown[] }).automationRules = [slotCapRule(2)];
    await setWeatherValue(collector, 28); // full need — uncapped ideal would be L6
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 0, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    gridReadings(collector, 12, 6);
    await checkAcLeveling(collector);

    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 2);
    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac1", "set_generator_mode", 6);
  });

  it("a slot flip to a lower cap reduces immediately (no gating)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    (collector as never as { automationRules: unknown[] }).automationRules = [slotCapRule(3)];
    await setWeatherValue(collector, 28);
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 0, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    gridReadings(collector, 12, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 3);

    // The active slot's cap drops to L1 — still inside the settle window, the
    // reduction ships on the very next tick (slot flip = structural change).
    (collector as never as { automationRules: unknown[] }).automationRules = [slotCapRule(1)];
    devices[0].generatorMode = 3;
    vi.advanceTimersByTime(5_000);
    gridReadings(collector, 12, 1);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 1);
  });

  it("sends the slot gen level directly when the automation opts out of leveling", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    tclCloud.getDevices.mockReturnValue([{ id: "ac1", maxGeneratorLevel: 6 }]);
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24); // dead zone of the 22–26 slot
    const rule = slotCapRule(2, {
      smart_leveling: false,
      action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3, generator_mode: 4 },
    });
    await checkAcRangeAutomation(collector, rule);

    // Slot gen level overrides the preset's generator_mode 4; fan is smart
    // auto (delta 24−22=2.0 → L6) since the slot has no fan override.
    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6, generator_mode: 2 });
  });

  it("clamps the direct-send slot gen level to the device max", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    tclCloud.getDevices.mockReturnValue([{ id: "ac1", maxGeneratorLevel: 3 }]);
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    const rule = slotCapRule(5, {
      smart_leveling: false,
      action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3 },
    });
    await checkAcRangeAutomation(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6, generator_mode: 3 });
  });

  it("skips the direct-send when the device cache is cold (no guessed max)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    tclCloud.getDevices.mockReturnValue([]); // cache cold — max unknown
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    const rule = slotCapRule(5, {
      smart_leveling: false,
      action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3 },
    });
    await checkAcRangeAutomation(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6 });
  });

  it("strips the slot gen level from profiles when the leveler manages the device", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);

    setTriggered(collector, 1);
    await setWeatherValue(collector, 24);
    const rule = slotCapRule(2, {
      action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3, generator_mode: 4 },
    });
    await checkAcRangeAutomation(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6 });
  });
});

describe("Per-range-slot vertical swing (vertical_swing)", () => {
  beforeEach(() => {
    acTimers.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function swingRule(swing: number | undefined, over: Record<string, unknown> = {}) {
    return {
      ...acRangeRule(),
      smart_leveling: false,
      range_slots: [
        { id: "default", type: "all_day", threshold_low: 22, threshold: 26, ...(swing != null ? { vertical_swing: swing } : {}) },
      ] satisfies AutomationRangeSlot[],
      ...over,
    };
  }

  async function reenforce(collector: Collector, rule: ReturnType<typeof swingRule>) {
    setTriggered(collector, 1);
    await setWeatherValue(collector, 24); // dead zone of the 22–26 slot → adopt profile
    await checkAcRangeAutomation(collector, rule);
  }

  it("applies the slot vertical swing, overriding the preset's", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    const rule = swingRule(11, {
      action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3, vertical_swing: 1 },
    });
    await reenforce(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6, vertical_swing: 11 });
  });

  it("falls through to the preset's vertical swing when the slot has none", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    const rule = swingRule(undefined, {
      action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3, vertical_swing: 1 },
    });
    await reenforce(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6, vertical_swing: 1 });
  });

  it("sends slot swing 0 (Off) — overrides the preset, not treated as absent", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    const rule = swingRule(0, {
      action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3, vertical_swing: 11 },
    });
    await reenforce(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6, vertical_swing: 0 });
  });

  it("applies the slot vertical swing on turn-on", async () => {
    const { collector, actions } = createCollector();
    await setWeatherValue(collector, 27); // above the 26 high limit → turn ON
    await checkAcRangeAutomation(collector, swingRule(2));

    // Smart-auto fan: delta 27−22=5 → L7; slot pins vertical_swing 2.
    expect(actions).toEqual([{ deviceId: "ac1", action: { power: 1, mode: 1, temperature: 23, fan_speed: 7, vertical_swing: 2 } }]);
  });

  it("suspends swing enforcement after a manual UI swing change", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    const rule = swingRule(11, {
      action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3, vertical_swing: 1 },
    });
    (collector as never as { automationRules: unknown[] }).automationRules = [rule];
    collector.noteUserAcSwingChange("ac1"); // user changed swing from the AC card
    await reenforce(collector, rule);

    // Swing is left untouched — the enforced diff carries no vertical_swing at all.
    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6 });
  });

  it("resumes swing enforcement when the active slot changes", async () => {
    const { collector, tclCloud } = createCollector();
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: true }]);
    // A manual override taken under a now-inactive slot must be ignored and cleared.
    (collector as never as { acSwingOverrides: Map<string, { slotId: string }> }).acSwingOverrides.set("1:ac1", { slotId: "stale-morning" });
    const rule = swingRule(11, {
      action_on: { power: 1, mode: 1, temperature: 23, fan_speed: 3, vertical_swing: 1 },
    });
    await reenforce(collector, rule);

    expect(tclCloud.computeAcDiff).toHaveBeenCalledWith("ac1", { mode: 1, temperature: 23, fan_speed: 6, vertical_swing: 11 });
    expect((collector as never as { acSwingOverrides: Map<string, unknown> }).acSwingOverrides.has("1:ac1")).toBe(false);
  });

  it("clears the swing override on a power cycle (turn-on)", async () => {
    const { collector, actions } = createCollector();
    const rule = swingRule(2);
    (collector as never as { automationRules: unknown[] }).automationRules = [rule];
    collector.noteUserAcSwingChange("ac1");   // manual swing override active...
    await setWeatherValue(collector, 27);     // ...then the AC power-cycles on turn-on
    await checkAcRangeAutomation(collector, rule);

    // Turn-on re-applies the slot swing (override dropped) and the override is gone.
    expect(actions).toEqual([{ deviceId: "ac1", action: { power: 1, mode: 1, temperature: 23, fan_speed: 7, vertical_swing: 2 } }]);
    expect((collector as never as { acSwingOverrides: Map<string, unknown> }).acSwingOverrides.has("1:ac1")).toBe(false);
  });
});

describe("Smart AC leveling — calibration handoff (ramp re-arm)", () => {
  beforeEach(() => {
    acTimers.clear();
  });

  it("rearmRamp keeps a calibration-restored AC's draw out of the non-AC load", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    // L3 with the grid budget exactly fitting L3 (29A measured → nonAcLoad 25
    // → budget 4 = floor 2A + two 1A steps) — the fitted ideal equals the
    // current level, so the first tick stays quiet.
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 3, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Established: the full est(L3)=4A is subtracted → nonAcLoad 25.
    gridReadings(collector, 29, 6);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().nonAcLoadAmps).toBe(25);

    // Calibration restored it (compressor restarted while leveling was
    // suspended) → ramp re-armed → only FLOOR credit (L1 = 2A) is subtracted.
    collector.acLeveler.rearmRamp(["ac1"]);
    gridReadings(collector, 29, 1);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().nonAcLoadAmps).toBe(27);
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
    await checkAcLeveling(collector); // fan reduce + bucket refill

    overLimitReadings(collector, 4);
    await checkAcLeveling(collector);
    expect(actions).toEqual([]); // bucket not yet re-emptied (1 point left)

    overLimitReadings(collector, 1);
    await checkAcLeveling(collector);

    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 0 } }]);
    expect(shed.has("ac2")).toBe(true);
    expect(fanHolds.has("ac2")).toBe(false); // shed releases the hold
    expect(fanHolds.has("ac1")).toBe(true);
  });

  it("restores a held fan in one jump and suppresses gen raises meanwhile", async () => {
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

    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_fan_speed", 3);
    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac1", "set_generator_mode", expect.anything());
    expect(collector.acLeveler.hasFanHold("ac1")).toBe(false); // one jump → hold complete
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

  it("a restart-loaded hold adopts the observed fan as baseline, then releases on a real change", async () => {
    const { collector, tclCloud, fanHolds, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    fanHolds.set("ac1", { original_fan: 3, last_set_fan: 1 });
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 6, currentTemp: 28, mode: 1, fanSpeed: 4 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // First post-restart observation: confirmedFan is unknown — adopt, don't release.
    headroomReadings(collector, 1);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.hasFanHold("ac1")).toBe(true);

    // A subsequent move off the adopted baseline is a genuine external change.
    devices[0].fanSpeed = 5;
    headroomReadings(collector, 1);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.hasFanHold("ac1")).toBe(false);
    expect(fanHolds.size).toBe(0);
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

describe("Smart AC leveling — emergency reduction fast path", () => {
  beforeEach(() => {
    acTimers.clear();
  });

  /** Prime away the initial source-change forceEvaluate so the emergency gate is what acts. */
  async function primeGen(collector: Collector) {
    genReadings(collector, 4, 1);
    await checkAcLeveling(collector);
  }

  const sentFloor = (tcl: { sendControl: { mock: { calls: unknown[][] } } }, id: string) =>
    tcl.sendControl.mock.calls.some((c) => c[0] === id && c[1] === "set_generator_mode" && c[2] === 1);

  it("cold start into gen: an emergency on the first tick does not lose the floor arming (2026-07-10)", async () => {
    const { collector, tclCloud, actions, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    // NO primeGen — this is the cold start. Both ACs adopted at L3 on generator.
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // Two 17A readings empty the bucket → the URGENT emergency tick acts and
    // returns BEFORE the floor-arming line. Because the one-shot arm is consumed
    // at the arming site (not captured near the ramp re-arm), the early return
    // does NOT drop it.
    genReadings(collector, 17, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actions.length).toBeGreaterThan(0);       // emergency shed acted
    expect(sentFloor(tclCloud, "ac1")).toBe(false);  // floors not enforced on the emergency tick

    // The next calm tick arms + enforces the floor (the arm survived the return).
    tclCloud.sendControl.mockClear();
    genReadings(collector, 8, 1);
    await checkAcLeveling(collector);
    expect(sentFloor(tclCloud, "ac1")).toBe(true);
  });

  it("acts on the 2nd severe reading (bucket empties), without waiting for the collector tick", async () => {
    const { collector, tclCloud, actions, shed, locks, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
    await primeGen(collector);
    expect(actions).toEqual([]);

    // 17A = +2A over (severe → 3 points each), so the 2nd reading empties the
    // 5-point bucket (6 ≥ 5) and fires the urgent dep; NO explicit leveling tick
    // happens here — only the microtask queue drains.
    genReadings(collector, 17, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // required = 2 (overshoot) + 1 (margin) = 3A; both ACs at L1 floors with
    // no reducible fans → nothing to cut → shed the least-needy (ac2, 4A ≥ 3A).
    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 0 } }]);
    expect(shed.has("ac2")).toBe(true);
    expect(locks.size).toBe(0);

    // A late explicit tick coalesces — no duplicate batch.
    await checkAcLeveling(collector);
    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 0 } }]);
  });

  it("regression: a sub-amp emergency uses learned fan cost to cut 7→4, not bounce 7→1", async () => {
    const { collector, tclCloud, actions, fanHolds, setLevelingConfig } = createCollector();
    setLevelingConfig({ ...LEVELING_CONFIG, marginAmps: 0.1 });
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3,
        currentTemp: 26, mode: 1, fanSpeed: 7 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
    await primeGen(collector);

    // Seed the cost that the live controller learned from clean fan restores.
    // The old emergency planner ignored this map and treated the whole 7→1
    // drop as one binary 0.5A move.
    (collector.acLeveler as never as {
      observedFanStepCost: Map<string, Map<string, number>>;
    }).observedFanStepCost = new Map([["gen", new Map([["ac1", 0.2]])]]);

    // Two mild points + one severe 3-point reading empty the 5-point bucket.
    // Median overshoot 0.5A + 0.1A margin = 0.6A required: exactly 3 fan steps.
    genReadings(collector, 15.5, 2);
    genReadings(collector, 17, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await checkAcLeveling(collector);

    expect(actions).toEqual([]);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_fan_speed", 4);
    expect(tclCloud.sendControl).not.toHaveBeenCalledWith("ac1", "set_fan_speed", 1);
    expect(fanHolds.get("ac1")).toEqual({ original_fan: 7, last_set_fan: 4 });
  });

  it("oscillation: 29↔31 around the 30A grid limit accumulates in the bucket and acts (31A-incident regression)", async () => {
    const { collector, tclCloud, actions, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
    gridReadings(collector, 29, 1);
    await checkAcLeveling(collector);
    expect(actions).toEqual([]);

    // The live 31A pattern: every 29A dip used to RESET the consecutive streaks,
    // so no streak gate could fire while the breaker heated on the duty cycle.
    // The leaky bucket accumulates instead: each 31A (+1A → 1 point) drains it,
    // the 29A dips don't refill (episode refill needs a full sustained-calm
    // streak), so 5 over-limit readings empty the 5-point bucket → it acts.
    for (const amps of [31, 29, 31, 29, 31, 29, 31, 29, 31]) {
      gridReadings(collector, amps, 1);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    // All-mild empty → allocator reduce; both at L1 floors, no fans → shed ac2.
    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 0 } }]);
    expect(shed.has("ac2")).toBe(true);
  });

  it("tolerates gen fluctuation around the limit until the bucket empties", async () => {
    const { collector, tclCloud, actions, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
    await primeGen(collector);

    // 14↔16 around the 15A gen limit — the user deliberately rides near the gen
    // breaker. The bucket works on BOTH sources now (no grid-only gate), but
    // tolerates this fluctuation: only 3 mild (+1A → 1 point) over-readings here
    // leave 2 points in the 5-point bucket, so it does NOT act on noise.
    for (const amps of [16, 14, 16, 14, 16]) {
      genReadings(collector, amps, 1);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await checkAcLeveling(collector);

    expect(actions).toEqual([]);
    expect(tclCloud.sendControl).not.toHaveBeenCalled();
  });

  it("tolerates a single severe blip then refills the bucket on sustained calm", async () => {
    const { collector, tclCloud, actions, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
    await primeGen(collector);

    // One 18A spike (severe → 3 points) leaves 2 of 5 in the bucket — NOT empty,
    // so it does not act (tolerates a turn-on inrush / momentary surge).
    genReadings(collector, 18, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await checkAcLeveling(collector);
    expect(actions).toEqual([]);
    expect(collector.acLeveler.getStatus().overLimitBudget).toBe(2);

    // Sustained genuine headroom (a full streak) refills the bucket to full —
    // the episode is over, the momentary points forgiven.
    genReadings(collector, 4, 6);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().overLimitBudget).toBe(5);
    expect(actions).toEqual([]);
  });

  it("throttles non-critical leveling pushes but always notifies a shed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
    try {
      const { collector, tclCloud, actions, setLevelingConfig } = createCollector();
      setLevelingConfig(LEVELING_CONFIG);
      await collector.acLeveler.ensureLoaded();
      const pushes: { body?: string }[] = [];
      (collector as never as { broadcastPush: (p: { body?: string }) => Promise<void> }).broadcastPush =
        async (p) => { pushes.push(p); };
      const devices = [
        { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
        { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      ];
      tclCloud.getDevices.mockReturnValue(devices);
      tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

      // Severe over-limit → shed ac2. A shed (an AC turned OFF) is actionable
      // and always notifies, even though it opens the throttle window.
      genReadings(collector, 18, 2);
      await checkAcLeveling(collector);
      expect(pushes).toHaveLength(1);
      expect(pushes[0].body).toContain("turned off");

      // ac2 off; load eases to 8A (headroom, but above the collapse floor so the
      // trip guard stays clear) → ac2 restores within the 5-min throttle window.
      // The restore DID happen, but its (non-critical) notice is suppressed.
      const afterShed = [devices[0], { ...devices[1], power: false }];
      tclCloud.getDevices.mockReturnValue(afterShed);
      tclCloud.fetchDevicesLive.mockResolvedValue(afterShed as never);
      vi.advanceTimersByTime(31_000);
      genReadings(collector, 8, 6);
      await checkAcLeveling(collector);
      expect(actions.some((a) => a.deviceId === "ac2" && a.action.power === 1)).toBe(true);
      expect(pushes).toHaveLength(1); // restore notice throttled
    } finally {
      vi.useRealTimers();
    }
  });

  it("cuts from the measured overshoot even when the frozen budget math says everything fits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
    try {
      const { collector, tclCloud, setLevelingConfig } = createCollector();
      setLevelingConfig(LEVELING_CONFIG);
      await collector.acLeveler.ensureLoaded();
      const devices = [
        { id: "ac1", name: "Najat", power: true, generatorMode: 4, maxGeneratorLevel: 6, currentTemp: 28, mode: 1 },
        { id: "ac2", name: "Abdu", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      ];
      tclCloud.getDevices.mockReturnValue(devices);
      tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

      // On GRID (30A) so the extreme-overshoot shed escalation (≥6A on grid) does
      // NOT fire — this test isolates the meter-sizing path with level cuts. The
      // +15A baseline vs the old gen scenario just lands in nonAcLoad; the amp
      // model (no genAmpModels ⇒ grid model on both sources) and every level/
      // required figure are unchanged.
      // Mild fitted reduce (Abdu L3→L2) arms the 15s nonAcLoad freeze at 17.5A.
      gridReadings(collector, 30.5, 5);
      await checkAcLeveling(collector);
      expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
      expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 2);

      // 5s later a non-AC load spike pushes the meter to 34A (severe ×2).
      // The FROZEN budget (30−1−17.5 = 11.5) still fits the fitted ideal
      // (Najat L4 + Abdu L2 == current levels), so computeAllocation ships
      // NOTHING despite 4A over — the meter-sized emergency must cut anyway:
      // required = 4 + 1 = 5A (< 6A grid shed threshold) → Abdu L2→L1 (2A) +
      // Najat L4→L1 (3A), one batch, no shed.
      vi.advanceTimersByTime(5_000);
      gridReadings(collector, 34, 2);
      await checkAcLeveling(collector);
      expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 1);
      expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 1);
      const emergency = collector.acLeveler.getStatus().lastEmergency;
      expect(emergency?.requiredAmps).toBe(5);
      expect(emergency?.savedAmps).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discounts a second streak while the batch lands, then sheds the sufficient AC in the same batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
    try {
      const { collector, tclCloud, actions, shed, setLevelingConfig } = createCollector();
      setLevelingConfig(LEVELING_CONFIG);
      await collector.acLeveler.ensureLoaded();
      const devices = [
        { id: "ac1", name: "Najat", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
        { id: "ac2", name: "Abdu", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 28, mode: 1 },
      ];
      tclCloud.getDevices.mockReturnValue(devices);
      tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
      // On GRID (30A) so batch 1 stays a LEVEL cut — the 4A required here is below
      // the 6A grid shed-escalation threshold. The +15A vs the old gen scenario
      // just lands in nonAcLoad; the amp model (grid model on both sources) and
      // every required/savings figure are unchanged.
      gridReadings(collector, 19, 1);
      await checkAcLeveling(collector);

      // Batch 1: 33A severe ×2 → required 3+1 = 4A → Abdu (least needy by
      // priority tiebreak) L3→L1 covers it exactly. Streaks reset after.
      gridReadings(collector, 33, 2);
      await checkAcLeveling(collector);
      expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
      expect(tclCloud.sendControl).toHaveBeenCalledWith("ac2", "set_generator_mode", 1);
      expect(collector.acLeveler.getStatus().overLimitBudget).toBe(5); // refilled after acting
      expect(collector.acLeveler.getStatus().lastEmergency).toMatchObject({ requiredAmps: 4, savedAmps: 4 });

      // 8s later the meter still reads 33A — the compressor hasn't responded
      // yet. The fresh severe streak is fully discounted by the in-flight 4A
      // (within EMERGENCY_PENDING_MS) → no stacked cut.
      vi.advanceTimersByTime(8_000);
      gridReadings(collector, 33, 2);
      await checkAcLeveling(collector);
      expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);

      // 16s after batch 1 the discount has expired and 18A persists — the cut
      // demonstrably wasn't enough (model error). Fresh required 4A, but only
      // Najat's 2A of level cuts remain — knowably insufficient, so the
      // sufficient AC (Abdu, 4A at L1) is shed in the SAME batch and Najat's
      // levels are spared (user decision 2026-06-12 PM, revising the
      // morning's shed-separate staging).
      vi.advanceTimersByTime(8_000);
      gridReadings(collector, 33, 2);
      await checkAcLeveling(collector);
      expect(tclCloud.sendControl).toHaveBeenCalledTimes(1); // no new level cmds
      expect(actions).toEqual([{ deviceId: "ac2", action: { power: 0 } }]);
      expect(shed.has("ac2")).toBe(true);

      // The shed lands on the device shadow (without this, the still-ON
      // observation would clear the shed as an external power-on after 15s).
      const afterShed = devices.map((d) => (d.id === "ac2" ? { ...d, power: false } : { ...d }));
      tclCloud.getDevices.mockReturnValue(afterShed);
      tclCloud.fetchDevicesLive.mockResolvedValue(afterShed as never);

      // 33A STILL persists with only Najat (top priority) left running: her
      // 2A of cuts can't cover 4A either — last resort sheds her too.
      vi.advanceTimersByTime(20_000);
      gridReadings(collector, 33, 2);
      await checkAcLeveling(collector);
      expect(actions).toEqual([
        { deviceId: "ac2", action: { power: 0 } },
        { deviceId: "ac1", action: { power: 0 } },
      ]);
      expect(shed.has("ac1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ships the sufficient shed and the remainder's fan drop in ONE batch (18A gen incident regression)", async () => {
    const { collector, tclCloud, actions, shed, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1, fanSpeed: 3 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 28, mode: 1, fanSpeed: 3 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);
    await primeGen(collector);
    expect(actions).toEqual([]);

    // The live 2026-06-12 shape: both at L1 floors, required 3.4+1 = 4.4A vs
    // 1A of fan cuts. The old staging shipped the knowably-insufficient fans,
    // then shed across two more streaks (~10s+ extra near a tripping
    // breaker). Now ONE batch: shed Abdu (4A, sufficient — Najat's 2A is
    // skipped) + Najat's fan for the 0.4A remainder. Najat keeps cooling.
    genReadings(collector, 18.4, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(actions).toEqual([{ deviceId: "ac2", action: { power: 0 } }]);
    expect(shed.has("ac2")).toBe(true);
    expect(shed.has("ac1")).toBe(false);
    expect(tclCloud.sendControl).toHaveBeenCalledTimes(1);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_fan_speed", 1);
    expect(collector.acLeveler.getStatus().lastEmergency).toMatchObject({
      requiredAmps: expect.closeTo(4.4, 5),
      savedAmps: expect.closeTo(4.5, 5),
    });
  });
});

// Regression: an expired Xiaomi session that triggers an in-loop re-auth must
// NOT freeze the collection loop. xiaomiCloud.init() blocks until a 2FA/captcha
// code is submitted (its on2fa callback returns a promise resolved only via
// POST /api/xiaomi/verify), so it must be launched fire-and-forget, never
// awaited inside checkAutomations. Awaiting it once froze weather/alerts/
// automations for ~4h (2026-07-02).
describe("in-loop Xiaomi re-auth does not block the collection loop", () => {
  it("checkAutomations returns promptly even when init() parks on a 2FA prompt", async () => {
    const { collector } = createCollector();

    // Skip the DB refresh (throttle) and inject a rule so checkAutomations
    // reaches the re-auth block instead of early-returning on empty rules.
    (collector as never as { automationRulesLastFetch: number }).automationRulesLastFetch = Date.now();
    (collector as never as { automationRules: unknown[] }).automationRules = [
      { id: 1, enabled: true, device_type: "purifier", automation_type: "metric", device_ids: [] },
    ];
    (collector as never as { xiaomiRetryAt: number }).xiaomiRetryAt = 0;

    let initCalls = 0;
    const fakeXiaomi = {
      isReady: () => false,
      getAuthStatus: () => ({ status: "error" as const }),
      // Simulates a login that parks on an un-answered 2FA prompt: never resolves.
      init: () => { initCalls++; return new Promise<void>(() => { /* never resolves */ }); },
    };
    (collector as never as { xiaomiCloud: typeof fakeXiaomi }).xiaomiCloud = fakeXiaomi;

    const hung = Symbol("hung");
    const result = await Promise.race([
      (collector as never as { checkAutomations: () => Promise<void> }).checkAutomations().then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve(hung), 500)),
    ]);

    expect(result).toBe("done"); // did NOT hang on the blocking init()
    expect(initCalls).toBe(1); // re-auth was still launched (fire-and-forget)
  });
});

describe("observed-off classification — power events vs manual (2026-07-06)", () => {
  beforeEach(() => {
    acTimers.clear();
  });

  function setTrig(collector: Collector, ruleId: number) {
    (collector as never as { automationState: Map<number, unknown> }).automationState.set(ruleId, {
      status: "triggered", lastToggle: 0, conditionSince: null, conditionLostAt: null, canAutoTurnOn: true,
    });
  }

  it("does not lock an observed off inside the power-event window and re-turns the AC on (the 02:44 incident)", async () => {
    const { collector, tclCloud, actions, locks } = createCollector();
    setTrig(collector, 1);
    collector.notePowerEvent("source grid → gen");
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: false }] as never);

    await setWeatherValue(collector, 27); // still hot — the automation wants it ON
    await checkAcRangeAutomation(collector, acRangeRule());

    expect(locks.size).toBe(0);
    expect(actions).toHaveLength(1);
    expect(actions[0].deviceId).toBe("ac1");
    expect(actions[0].action.power).toBe(1);
    const state = (collector as never as { automationState: Map<number, { status: string }> }).automationState.get(1);
    expect(state?.status).toBe("triggered");
  });

  it("locks an observed off with no power-event context (genuine manual off unchanged)", async () => {
    const { collector, tclCloud, actions, locks } = createCollector();
    setTrig(collector, 1);
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: false }] as never);

    await setWeatherValue(collector, 27);
    await checkAcRangeAutomation(collector, acRangeRule());

    expect(locks.has("ac1")).toBe(true);
    expect(actions).toEqual([]);
    const state = (collector as never as { automationState: Map<number, { status: string }> }).automationState.get(1);
    expect(state?.status).toBe("idle");
  });

  it("reads a beep-reset fingerprint as a power-loss off (brownout outside the window)", async () => {
    const { collector, tclCloud, actions, locks, beepPrefs } = createCollector();
    setTrig(collector, 1);
    beepPrefs.add("ac1"); // beep-off enforced — firmware resets it to ON only on a power-loss restart
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: false }] as never);
    tclCloud.getDevices.mockReturnValue([{ id: "ac1", power: false, beep: true, fanSpeed: 3 }]);

    await setWeatherValue(collector, 27);
    await checkAcRangeAutomation(collector, acRangeRule());

    expect(locks.size).toBe(0);
    expect(actions).toHaveLength(1);
    expect(actions[0].action.power).toBe(1);
  });

  it("never locks on a fetch gap (power undefined is not an observation)", async () => {
    const { collector, tclCloud, actions, locks } = createCollector();
    setTrig(collector, 1);
    tclCloud.fetchDevicesLive.mockResolvedValue([] as never);

    await setWeatherValue(collector, 27);
    await checkAcRangeAutomation(collector, acRangeRule());

    expect(locks.size).toBe(0);
    expect(actions).toEqual([]);
    const state = (collector as never as { automationState: Map<number, { status: string }> }).automationState.get(1);
    expect(state?.status).toBe("triggered");
  });

  it("schedule: a power-event off during the window is re-turned on instead of locked", async () => {
    const { collector, tclCloud, actions, locks } = createCollector();
    const rule = activeScheduleRule();
    setTrig(collector, rule.id);
    collector.notePowerEvent("ESP gap 23s");
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: false }] as never);

    await checkScheduleAutomation(collector, rule);

    expect(locks.size).toBe(0);
    expect(actions).toHaveLength(1);
    expect(actions[0].action.power).toBe(1);
  });

  it("a dashboard off inside a power-event window keeps its lock and is never auto-resumed (Najat 2026-07-06)", async () => {
    const { collector, tclCloud, actions, locks } = createCollector();
    setTrig(collector, 1);
    collector.notePowerEvent("power collapse on gen");
    // The UI off records the lock BEFORE the shadow ever reports the off
    await collector.recordAcManualOff("ac1", "ui");
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: false }] as never);

    await setWeatherValue(collector, 27); // still hot — the automation wants it ON
    await checkAcRangeAutomation(collector, acRangeRule());

    expect(locks.has("ac1")).toBe(true); // the sacred lock survives
    expect(actions).toEqual([]);         // no power-event re-on
    const state = (collector as never as { automationState: Map<number, { status: string }> }).automationState.get(1);
    expect(state?.status).toBe("idle");
  });

  it("a remote/TCL-app off inside the window locks when beep is still off (unit never lost power)", async () => {
    const { collector, tclCloud, actions, locks, beepPrefs } = createCollector();
    setTrig(collector, 1);
    beepPrefs.add("ac1"); // beep-off enforced — a power-loss restart would have reset beep to ON
    collector.notePowerEvent("source gen → grid");
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: false }] as never);
    tclCloud.getDevices.mockReturnValue([{ id: "ac1", power: false, beep: false, fanSpeed: 3 }]);

    await setWeatherValue(collector, 27);
    await checkAcRangeAutomation(collector, acRangeRule());

    expect(locks.has("ac1")).toBe(true); // beep=false proves no restart → manual off
    expect(actions).toEqual([]);
  });

  it("a power-loss off inside the window (beep reset to ON) still auto-resumes", async () => {
    const { collector, tclCloud, actions, locks, beepPrefs } = createCollector();
    setTrig(collector, 1);
    beepPrefs.add("ac1");
    collector.notePowerEvent("source gen → grid");
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: false }] as never);
    tclCloud.getDevices.mockReturnValue([{ id: "ac1", power: false, beep: true, fanSpeed: 0 }]);

    await setWeatherValue(collector, 27);
    await checkAcRangeAutomation(collector, acRangeRule());

    expect(locks.size).toBe(0);
    expect(actions).toHaveLength(1);
    expect(actions[0].action.power).toBe(1);
  });
});

describe("collector loop watchdog + step deadlines (2026-07-06 stall)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("abandons a hung step at its deadline — later steps still run", async () => {
    const { collector } = createCollector();
    const c = collector as never as {
      collectAmbientWeather: () => Promise<void>;
      collectQingping: () => Promise<void>;
      checkAlerts: () => Promise<void>;
      checkAutomations: () => Promise<void>;
      checkAcTimers: () => Promise<void>;
      runLevelingCheck: () => Promise<void>;
      checkAcBeepEnforcement: () => Promise<void>;
      collectAll: () => Promise<void>;
      acCalibrator: unknown;
    };
    c.collectAmbientWeather = async () => {};
    c.collectQingping = async () => {};
    c.checkAlerts = () => new Promise<void>(() => {}); // hangs forever (the stall)
    c.acCalibrator = { tick: async () => {} };
    c.checkAutomations = async () => {};
    let timersRan = false;
    c.checkAcTimers = async () => { timersRan = true; };
    c.runLevelingCheck = async () => {};
    c.checkAcBeepEnforcement = async () => {};

    const cycle = c.collectAll();
    await vi.advanceTimersByTimeAsync(90_001);
    await cycle;

    expect(timersRan).toBe(true);
  });

  it("watchdog warns below 3 min and exits the process past it (container restart self-heal)", () => {
    const { collector } = createCollector();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      (collector as never as { startLoopWatchdog: () => void }).startLoopWatchdog();

      (collector as never as { lastLoopTickAt: number }).lastLoopTickAt = Date.now() - 90_000;
      vi.advanceTimersByTime(30_000);
      expect(exitSpy).not.toHaveBeenCalled();

      (collector as never as { lastLoopTickAt: number }).lastLoopTickAt = Date.now() - 4 * 60_000;
      vi.advanceTimersByTime(30_000);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      collector.stop();
      exitSpy.mockRestore();
    }
  });
});

describe("shadow sanity gate — raises frozen while the meter can't see demanding shadow-ON ACs (P5)", () => {
  it("skips raises on stale post-blackout shadows, resumes once meter and shadows converge", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    setLevelingConfig(LEVELING_CONFIG);
    await collector.acLeveler.ensureLoaded();
    // Both rooms hot (demanding) — their compressors MUST draw at least the
    // floor if they are really on. Floors: ac1 2A + ac2 4A = 6A.
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 29, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 29, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 3A on gen: the meter can't carry even the 6A floor draw — the shadows
    // are lying (post-blackout lag). No raise may fire into that.
    genReadings(collector, 3, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).not.toHaveBeenCalled();

    // The ACs really start drawing → gate self-expires, raises resume.
    genReadings(collector, 8, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalled();
  });
});

describe("raise-hold meter-anchored release (P6, 2026-07-06)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases on real meter headroom when the model expectation exceeds the limit (impossible arrival)", async () => {
    const { collector, tclCloud, setLevelingConfig } = createCollector();
    // ac2's fat model claims 12A at L3 while its real draw is ~3A (cap above
    // demand) — the model-sum expectation lands ABOVE the 15A limit, so the
    // arrival/provable releases can never fire (live: "once ~29.9A is seen"
    // on a 28A grid limit) and every hold ran its full timeout.
    setLevelingConfig({
      ...LEVELING_CONFIG,
      gridLimitAmps: 15,
      ampModels: { ac1: { baseAmps: 2, stepAmps: 1 }, ac2: { baseAmps: 8, stepAmps: 2 } },
    });
    await collector.acLeveler.ensureLoaded();
    const devices = [
      { id: "ac1", name: "Najat", power: true, generatorMode: 1, maxGeneratorLevel: 3, currentTemp: 29, mode: 1 },
      { id: "ac2", name: "Abdu", power: true, generatorMode: 3, maxGeneratorLevel: 3, currentTemp: 24, mode: 1 },
    ];
    tclCloud.getDevices.mockReturnValue(devices);
    tclCloud.fetchDevicesLive.mockResolvedValue(devices as never);

    // 5A on grid → ac1 raised straight to L3 (meter-anchored), hold armed with
    // expectedAmps ≈ 16A — above the 15A limit.
    gridReadings(collector, 5, 6);
    await checkAcLeveling(collector);
    expect(tclCloud.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 3);
    expect(collector.acLeveler.getStatus().raiseHoldRemainingMs).toBeGreaterThan(0);

    // The raise lands (+2A): pending is accounted for, the meter is far under
    // the limit → meter-anchored release frees the hold well inside the 120s.
    const after = [{ ...devices[0], generatorMode: 3 }, devices[1]];
    tclCloud.getDevices.mockReturnValue(after);
    tclCloud.fetchDevicesLive.mockResolvedValue(after as never);
    vi.advanceTimersByTime(31_000);
    gridReadings(collector, 7, 6);
    await checkAcLeveling(collector);
    expect(collector.acLeveler.getStatus().raiseHoldRemainingMs).toBe(0);
  });
});
