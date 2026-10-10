// Remote off must stick (owner report 2026-09-27): Mom's AC "turns back on by
// itself" after she switches it OFF with the IR remote. The collector half:
//   R2 the 120 s server-ON shadow-lag fast path claimed every off inside it as
//      lag without consulting anything, so a remote off right after one of our
//      ONs was reversed. The shadow's own metadata now tells them apart: a
//      powerSwitch report that came ALONE, strictly after our send, is the unit
//      going off by itself, so it goes to the classifier.
//   R4 the range site cleared the fan intent BEFORE classifying, which deleted
//      the `lastCommandedFan` evidence the fan-0 power-loss fingerprint reads.
//   R5 fan Auto claimed "resuming automation fan enforcement" even when no
//      enabled range rule owned the AC.
// A separate file so the logger can be captured without touching the
// thousands of lines of collector.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { logLines } = vi.hoisted(() => ({ logLines: [] as string[] }));
vi.mock("./logger.js", () => {
  const capture = (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  };
  return { childLogger: () => ({ info: capture, warn: capture, error: capture, debug: capture }) };
});
vi.mock("./ac-capabilities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ac-capabilities.js")>();
  // Synthetic ac1 ids, same seam as collector.test.ts.
  return { ...actual, isAcLevelingEligible: (deviceId: string) => deviceId !== "DlXqDBFAAAE" };
});

import type { Config } from "./config.js";
import { Collector } from "./collector.js";
import { AcProfileNotAppliedError } from "./tcl-cloud.js";
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
  hermesApiToken: "",
  observedOffLocks: true,
};

function createCollector(shared: { locks?: Set<string>; beepPrefs?: Set<string> } = {}) {
  const locks = shared.locks ?? new Set<string>();
  const beepPrefs = shared.beepPrefs ?? new Set<string>();
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("SELECT") && sql.includes("FROM ac_beep_off")) {
      return { rows: Array.from(beepPrefs, (device_id) => ({ device_id })), rowCount: beepPrefs.size };
    }
    if (sql.includes("SELECT") && sql.includes("FROM ac_manual_off_locks")) {
      return { rows: Array.from(locks, (device_id) => ({ device_id, locked_at: new Date(Date.now() - 20_000) })), rowCount: locks.size };
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
  const collector = new Collector({ query } as never, config);
  const actions: Array<{ deviceId: string; action: Record<string, unknown> }> = [];
  const tclCloud = {
    isReady: vi.fn(() => true),
    ensureDeviceCachePopulated: vi.fn(async () => undefined),
    getDevices: vi.fn(() => [] as Record<string, unknown>[]),
    fetchDevicesLive: vi.fn(async () => [{ id: "ac1", power: false }] as Record<string, unknown>[]),
    executeAcAction: vi.fn(async (deviceId: string, action: Record<string, unknown>) => {
      actions.push({ deviceId, action });
    }),
    sendControl: vi.fn(async () => undefined),
    preparePowerCycleRestore: vi.fn(() => true),
    computeAcDiff: vi.fn(() => null as Record<string, unknown> | null),
    getDeviceState: vi.fn(() => null as Record<string, unknown> | null),
  };
  (collector as never as { tclCloud: typeof tclCloud }).tclCloud = tclCloud;
  (collector as never as { latestWeatherTs: Date }).latestWeatherTs = new Date();
  (collector as never as { latestWeatherRow: Record<string, unknown> }).latestWeatherRow = { temp_indoor_c: 27 };
  const pushed: string[] = [];
  (collector as never as { broadcastPush: (p: { title?: string }) => Promise<void> }).broadcastPush = async (p) => {
    pushed.push(p.title ?? "");
  };
  return { collector, tclCloud, actions, locks, beepPrefs, pushed };
}

function acRangeRule(overrides: Record<string, unknown> = {}) {
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
    range_slots: null,
    ...overrides,
  };
}

function setTriggered(collector: Collector, ruleId: number) {
  (collector as never as { automationState: Map<number, unknown> }).automationState.set(ruleId, {
    status: "triggered", lastToggle: 0, conditionSince: null, conditionLostAt: null, canAutoTurnOn: true,
  });
}

async function checkAcRange(collector: Collector, rule: ReturnType<typeof acRangeRule>) {
  await (collector as never as { checkAcRangeAutomation: (r: unknown) => Promise<void> }).checkAcRangeAutomation(rule);
}

function observedOff(collector: Collector, deviceId = "ac1", name = "Mom"): Promise<boolean> {
  return (collector as never as {
    handleObservedAcOff: (context: string, deviceId: string, deviceName: string) => Promise<boolean>;
  }).handleObservedAcOff("test", deviceId, name);
}

const serverOnMap = (c: Collector) => (c as never as { lastServerAcOnAt: Map<string, number> }).lastServerAcOnAt;
const reversalMap = (c: Collector) => (c as never as { acServerOnReversalAt: Map<string, number> }).acServerOnReversalAt;
const fanEnforcement = (c: Collector) =>
  (c as never as { acFanEnforcement: Map<string, { manual: boolean; lastCommandedFan: number | null }> }).acFanEnforcement;
const swingOverrides = (c: Collector) => (c as never as { acSwingOverrides: Map<string, unknown> }).acSwingOverrides;

/** Epoch-second start of the report second, `secAfter` seconds after `sentAt`. */
const reportedSecAfter = (sentAt: number, secAfter: number) => (Math.floor(sentAt / 1000) + secAfter) * 1000;

beforeEach(() => {
  acTimers.clear();
  logLines.length = 0;
});

describe("R2: the server-ON shadow-lag fast path yields to a report that proves the unit went off", () => {
  it("our ON's dump, then an ISOLATED off, is classified (beep still off: a hand), locked and pushed", async () => {
    const { collector, tclCloud, locks, beepPrefs, pushed } = createCollector();
    beepPrefs.add("ac1");
    const sentAt = Date.now() - 20_000; // our ON, 20 s ago: well inside the 120 s grace
    serverOnMap(collector).set("ac1", sentAt);
    tclCloud.getDevices.mockReturnValue([
      { id: "ac1", power: false, beep: false, fanSpeed: 3, fullStateReportAt: reportedSecAfter(sentAt, 2), powerReportedAt: reportedSecAfter(sentAt, 12), powerReportCohort: 1 },
    ]);

    const resumed = await observedOff(collector);

    expect(resumed).toBe(false);
    expect(locks.has("ac1")).toBe(true);
    expect(pushed).toContain("AC automation paused");
    expect(logLines.some((l) => l.includes("reported by the unit") && l.includes("not shadow lag, classifying"))).toBe(true);
    expect(reversalMap(collector).has("ac1"), "no grace reversal was booked").toBe(false);
  });

  it("the range site does not re-send power=1 over a remote off that landed after our ON", async () => {
    const { collector, tclCloud, actions, locks, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    setTriggered(collector, 1);
    const sentAt = Date.now() - 20_000;
    serverOnMap(collector).set("ac1", sentAt);
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: false }]);
    tclCloud.getDevices.mockReturnValue([
      { id: "ac1", power: false, beep: false, fanSpeed: 3, fullStateReportAt: reportedSecAfter(sentAt, 2), powerReportedAt: reportedSecAfter(sentAt, 12), powerReportCohort: 2 },
    ]);

    await checkAcRange(collector, acRangeRule());

    expect(locks.has("ac1")).toBe(true);
    expect(actions).toEqual([]);
  });

  it("a STALE off report (older than our ON) is still shadow lag: reversed, never locked", async () => {
    const { collector, tclCloud, locks, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    const sentAt = Date.now() - 20_000;
    serverOnMap(collector).set("ac1", sentAt);
    tclCloud.getDevices.mockReturnValue([
      { id: "ac1", power: false, beep: false, fanSpeed: 3, fullStateReportAt: reportedSecAfter(sentAt, -400), powerReportedAt: reportedSecAfter(sentAt, -300), powerReportCohort: 1 },
    ]);

    expect(await observedOff(collector)).toBe(true);
    expect(locks.has("ac1")).toBe(false);
  });

  it("an off stamped inside a FULL-STATE dump after our ON (a reconnect) is still shadow lag", async () => {
    const { collector, tclCloud, locks, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    const sentAt = Date.now() - 20_000;
    serverOnMap(collector).set("ac1", sentAt);
    tclCloud.getDevices.mockReturnValue([
      { id: "ac1", power: false, beep: false, fanSpeed: 3, fullStateReportAt: reportedSecAfter(sentAt, 12), powerReportedAt: reportedSecAfter(sentAt, 12), powerReportCohort: 48 },
    ]);

    expect(await observedOff(collector)).toBe(true);
    expect(locks.has("ac1")).toBe(false);
  });

  it("no power-report metadata keeps today's shadow-lag reading", async () => {
    const { collector, tclCloud, locks, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    serverOnMap(collector).set("ac1", Date.now() - 20_000);
    tclCloud.getDevices.mockReturnValue([{ id: "ac1", power: false, beep: false, fanSpeed: 3 }]);

    expect(await observedOff(collector)).toBe(true);
    expect(locks.has("ac1")).toBe(false);
  });

  it("hard rule 2: an isolated off near a power event with the buzzer reset (power-loss restart) never locks", async () => {
    const { collector, tclCloud, locks, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    collector.notePowerEvent("source grid → gen");
    const sentAt = Date.now() - 20_000;
    serverOnMap(collector).set("ac1", sentAt);
    tclCloud.getDevices.mockReturnValue([
      { id: "ac1", power: false, beep: true, fanSpeed: 0, fullStateReportAt: reportedSecAfter(sentAt, 2), powerReportedAt: reportedSecAfter(sentAt, 12), powerReportCohort: 1 },
    ]);

    expect(await observedOff(collector)).toBe(true); // classifier: power event → resume, no lock
    expect(locks.has("ac1")).toBe(false);
  });
});

describe("R4: the range site classifies BEFORE it forgets the fan it commanded", () => {
  it("fan reset to 0 while we had commanded a fan still reads as a power-loss off (no lock, re-ON)", async () => {
    const { collector, tclCloud, actions, locks } = createCollector();
    setTriggered(collector, 1);
    // No beep pref, no power event, no server ON: only the fan fingerprint can speak.
    fanEnforcement(collector).set("1:ac1", { slotId: "default", lastCommandedFan: 3, lastFanCommandAt: 0, manual: true } as never);
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: false }]);
    tclCloud.getDevices.mockReturnValue([{ id: "ac1", power: false, beep: false, fanSpeed: 0 }]);

    await checkAcRange(collector, acRangeRule());

    expect(locks.has("ac1"), "fan 0 after a commanded fan is the power-loss fingerprint").toBe(false);
    expect(actions).toHaveLength(1);
    expect(actions[0].action.power).toBe(1);
    // …and the pre-cycle manual fan intent is still dropped, exactly as before.
    expect(fanEnforcement(collector).get("1:ac1")?.manual ?? false).toBe(false);
  });

  it("a genuine manual off still clears fan and swing intent after classifying", async () => {
    const { collector, tclCloud, locks } = createCollector();
    setTriggered(collector, 1);
    fanEnforcement(collector).set("1:ac1", { slotId: "default", lastCommandedFan: 3, lastFanCommandAt: 0, manual: true } as never);
    swingOverrides(collector).set("1:ac1", { slotId: "default" });
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: false }]);
    tclCloud.getDevices.mockReturnValue([{ id: "ac1", power: false, beep: false, fanSpeed: 3 }]);

    await checkAcRange(collector, acRangeRule());

    expect(locks.has("ac1")).toBe(true);
    expect(fanEnforcement(collector).has("1:ac1")).toBe(false);
    expect(swingOverrides(collector).has("1:ac1")).toBe(false);
  });
});

describe("R5: fan Auto logs who actually owns the fan", () => {
  it("names the enabled range rule that resumes smart-auto enforcement", () => {
    const { collector } = createCollector();
    (collector as never as { automationRules: unknown[] }).automationRules = [acRangeRule()];
    fanEnforcement(collector).set("1:ac1", { slotId: "default", lastCommandedFan: 3, lastFanCommandAt: 0, manual: true } as never);

    collector.noteUserAcFanAuto("ac1");

    expect(fanEnforcement(collector).has("1:ac1")).toBe(false);
    const line = logLines.find((l) => l.includes("user fan Auto"));
    expect(line).toContain('"Mom AC range"');
    expect(line).toContain("smart auto");
  });

  it("with no enabled range rule, says the unit stays on its built-in auto (live 2026-09-26: rule disabled)", () => {
    const { collector } = createCollector();
    // The owner's rule is disabled: a stale cache row, or none at all.
    (collector as never as { automationRules: unknown[] }).automationRules = [acRangeRule({ enabled: false })];
    fanEnforcement(collector).set("1:ac1", { slotId: "default", lastCommandedFan: 3, lastFanCommandAt: 0, manual: true } as never);

    collector.noteUserAcFanAuto("ac1");

    expect(fanEnforcement(collector).has("1:ac1"), "the stale entry is still dropped").toBe(false);
    const line = logLines.find((l) => l.includes("user fan Auto"));
    expect(line).toBeDefined();
    expect(line).not.toContain("resuming automation fan enforcement");
    expect(line).toContain("built-in auto");
  });

  it("with no rule and nothing to drop, still states the honest outcome", () => {
    const { collector } = createCollector();
    (collector as never as { automationRules: unknown[] }).automationRules = [];

    collector.noteUserAcFanAuto("ac1");

    const line = logLines.find((l) => l.includes("user fan Auto"));
    expect(line).toContain("built-in auto");
  });
});

// ---------------------------------------------------------------------------
// Review round (Sol, 2026-09-27): the ON reference time, the persisted decline,
// causal evidence and restart voids, and the honest fan-Auto log.
// ---------------------------------------------------------------------------

/** A device whose shadow shows our ON's dump `dumpSec` after `sentAt`, then a lone OFF `offSec` after it. */
function humanOffDevice(sentAt: number, dumpSec = 2, offSec = 12, extra: Record<string, unknown> = {}) {
  return {
    id: "ac1", name: "Mom", power: false, beep: false, fanSpeed: 3,
    fullStateReportAt: reportedSecAfter(sentAt, dumpSec),
    powerReportedAt: reportedSecAfter(sentAt, offSec),
    powerReportCohort: 1,
    ...extra,
  };
}

function levelerDeps(c: Collector) {
  return (c.acLeveler2 as unknown as {
    deps: { onRestoreDeclined: (id: string, sentAt: number, dev: unknown) => Promise<boolean> };
  }).deps;
}

describe("item 1: the server-ON reference is when the power ON was PUBLISHED", () => {
  it("an automation ON whose profile step takes 3 s: a remote off inside that gap is still judged against the publish", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-27T15:21:00.300Z"));
      const { collector, tclCloud, locks, beepPrefs, actions } = createCollector();
      beepPrefs.add("ac1");
      let publishedAt = 0;
      tclCloud.executeAcAction.mockImplementation(async (deviceId: string, action: Record<string, unknown>) => {
        actions.push({ deviceId, action });
        publishedAt = Date.now(); // powerSwitch:1 goes out first...
        vi.setSystemTime(Date.now() + 3_000); // ...then ~3 s for the profile
      });
      await (collector as never as { executeAutomationAction: (r: unknown, a: unknown, ids: string[]) => Promise<void> })
        .executeAutomationAction(acRangeRule(), { power: 1, mode: 1, temperature: 23 }, ["ac1"]);
      // Dump 1 s after the publish, remote OFF 2 s after it: both before the call returned.
      tclCloud.getDevices.mockReturnValue([humanOffDevice(publishedAt, 1, 2)]);

      expect(await observedOff(collector)).toBe(false);
      expect(locks.has("ac1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the leveler's restore passes its publish time through setDevicePowerCache", () => {
    const { collector } = createCollector();
    const deps = (collector.acLeveler2 as unknown as {
      deps: { setDevicePowerCache: (id: string, p: "on" | "off", at?: number) => void };
    }).deps;
    const publishedAt = Date.now() - 3_000;
    deps.setDevicePowerCache("ac1", "on", publishedAt);
    expect(serverOnMap(collector).get("ac1")).toBe(publishedAt);
  });
});

describe("item 2: a declined restore records the PERSISTENT lock through the collector's own judgment", () => {
  it("records restore_declined + push; an IDLE hot rule then never turns the AC on, before or after a restart", async () => {
    const { collector, tclCloud, actions, locks, beepPrefs, pushed } = createCollector();
    beepPrefs.add("ac1");
    const sentAt = Date.now() - 20_000;
    const dev = humanOffDevice(sentAt);
    tclCloud.getDevices.mockReturnValue([dev]);
    tclCloud.fetchDevicesLive.mockResolvedValue([dev]);

    expect(await levelerDeps(collector).onRestoreDeclined("ac1", sentAt, dev)).toBe(true);
    expect(locks.has("ac1")).toBe(true);
    expect(pushed).toContain("AC automation paused");
    expect(logLines.some((l) => l.includes("manual-off lock recorded (restore_declined)"))).toBe(true);

    // The range rule is IDLE (its auto-on path never classifies) and the room is hot.
    await checkAcRange(collector, acRangeRule());
    expect(actions, "the lock blocks the idle rule's auto-on").toEqual([]);

    // Restart: a fresh collector loads the lock from the DB.
    const restarted = createCollector({ locks, beepPrefs });
    restarted.tclCloud.getDevices.mockReturnValue([dev]);
    restarted.tclCloud.fetchDevicesLive.mockResolvedValue([dev]);
    await checkAcRange(restarted.collector, acRangeRule());
    expect(restarted.actions, "still off after a restart").toEqual([]);
  });

  it("near a power event with the buzzer reset (a real restart), the decline is refused and nothing locks", async () => {
    const { collector, tclCloud, locks, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    const sentAt = Date.now() - 20_000;
    collector.notePowerEvent("ESP gap 30s"); // opens the window without being a restart kind
    const dev = humanOffDevice(sentAt, 2, 12, { beep: true, fanSpeed: 0 });
    tclCloud.getDevices.mockReturnValue([dev]);

    expect(await levelerDeps(collector).onRestoreDeclined("ac1", sentAt, dev)).toBe(false);
    expect(locks.has("ac1")).toBe(false);
  });

  it("ambiguous evidence (no post-send dump) is refused", async () => {
    const { collector, tclCloud, locks, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    const sentAt = Date.now() - 20_000;
    const dev = humanOffDevice(sentAt, -300, 12);
    tclCloud.getDevices.mockReturnValue([dev]);

    expect(await levelerDeps(collector).onRestoreDeclined("ac1", sentAt, dev)).toBe(false);
    expect(locks.has("ac1")).toBe(false);
  });
});

describe("item 3: an isolated OFF stamped after our send is not enough without our ON's dump before it", () => {
  it("a late-delivered lone OFF (no post-send dump) stays shadow lag", async () => {
    const { collector, tclCloud, locks, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    const sentAt = Date.now() - 20_000;
    serverOnMap(collector).set("ac1", sentAt);
    tclCloud.getDevices.mockReturnValue([humanOffDevice(sentAt, -300, 12)]);

    expect(await observedOff(collector)).toBe(true);
    expect(locks.has("ac1")).toBe(false);
  });
});

describe("item 4: a restart after our ON voids the human-off verdict (hard rule 2)", () => {
  it("a source change after our ON, even with beep still reading off (reset not shown yet): no lock", async () => {
    const { collector, tclCloud, locks, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    const sentAt = Date.now() - 20_000;
    serverOnMap(collector).set("ac1", sentAt);
    collector.notePowerEvent("source grid → gen"); // after our ON
    tclCloud.getDevices.mockReturnValue([humanOffDevice(sentAt)]);

    expect(await observedOff(collector)).toBe(true);
    expect(locks.has("ac1")).toBe(false);
    expect(await levelerDeps(collector).onRestoreDeclined("ac1", sentAt, humanOffDevice(sentAt))).toBe(false);
    expect(locks.has("ac1")).toBe(false);
  });

  it("a collapse after our ON: no lock", async () => {
    const { collector, tclCloud, locks, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    const sentAt = Date.now() - 20_000;
    serverOnMap(collector).set("ac1", sentAt);
    collector.notePowerEvent("power collapse on gen");
    tclCloud.getDevices.mockReturnValue([humanOffDevice(sentAt)]);

    expect(await observedOff(collector)).toBe(true);
    expect(locks.has("ac1")).toBe(false);
  });

  it("a beep-reset sighting of this unit after our ON (a blackout with no source change): no lock", async () => {
    const { collector, tclCloud, locks, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    const sentAt = Date.now() - 20_000;
    serverOnMap(collector).set("ac1", sentAt);
    // The unit came back ON after a power loss with the buzzer reset...
    tclCloud.getDevices.mockReturnValue([{ id: "ac1", name: "Mom", power: true, beep: true, fanSpeed: 3 }]);
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", name: "Mom", power: true, beep: true, fanSpeed: 3 }]);
    await (collector as never as { checkAcBeepEnforcement: () => Promise<void> }).checkAcBeepEnforcement();
    // ...and a lone OFF follows, with the shadow's beep lagging at false.
    tclCloud.getDevices.mockReturnValue([humanOffDevice(sentAt)]);

    expect(await observedOff(collector)).toBe(true);
    expect(locks.has("ac1")).toBe(false);
  });
});

describe("item 6: fan Auto says what the owning rule's active slot will do", () => {
  it("a fixed-fan slot is named as such", () => {
    const { collector } = createCollector();
    (collector as never as { automationRules: unknown[] }).automationRules = [
      acRangeRule({ range_slots: [{ id: "allday", type: "all_day", threshold_low: 22, threshold: 26, fan_speed: 4 }] }),
    ];
    collector.noteUserAcFanAuto("ac1");
    const line = logLines.find((l) => l.includes("user fan Auto"));
    expect(line).toContain('"Mom AC range" (slot "allday": fixed fan 4)');
  });

  it("a smart-auto slot is named as such", () => {
    const { collector } = createCollector();
    (collector as never as { automationRules: unknown[] }).automationRules = [acRangeRule()];
    collector.noteUserAcFanAuto("ac1");
    expect(logLines.find((l) => l.includes("user fan Auto"))).toContain('"Mom AC range" (slot "default": smart auto)');
  });

  it("a rule with no slot active right now says nothing is enforced", () => {
    const { collector } = createCollector();
    const baghdad = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Baghdad" }));
    const fmt = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const start = new Date(baghdad.getTime() + 2 * 3_600_000);
    const end = new Date(baghdad.getTime() + 3 * 3_600_000);
    (collector as never as { automationRules: unknown[] }).automationRules = [
      acRangeRule({
        range_slots: [{ id: "later", type: "window", start_mode: "exact", start_time: fmt(start), end_mode: "exact", end_time: fmt(end), threshold_low: 22, threshold: 26 }],
      }),
    ];
    collector.noteUserAcFanAuto("ac1");
    expect(logLines.find((l) => l.includes("user fan Auto"))).toContain("no active slot");
  });
});

describe("partial success: the power ON was accepted, only the profile publish failed (Sol recheck 2026-09-27)", () => {
  function partialExecute(tclCloud: ReturnType<typeof createCollector>["tclCloud"], actions: Array<{ deviceId: string; action: Record<string, unknown> }>) {
    let publishedAt = 0;
    tclCloud.executeAcAction.mockImplementation(async (deviceId: string, action: Record<string, unknown>) => {
      actions.push({ deviceId, action });
      if (action.power === 1) {
        publishedAt = Date.now();
        throw new AcProfileNotAppliedError(deviceId, new Error("profile publish HTTP 503"));
      }
    });
    return () => publishedAt;
  }

  it("automation turn-on: the rule counts the ON as sent (triggered), stamps the server ON, and a later human OFF locks with no re-send", async () => {
    const { collector, tclCloud, actions, locks, beepPrefs } = createCollector();
    beepPrefs.add("ac1");
    const publishedAt = partialExecute(tclCloud, actions);
    tclCloud.fetchDevicesLive.mockResolvedValue([{ id: "ac1", power: false }]);

    await checkAcRange(collector, acRangeRule()); // idle + hot → turning ON
    expect(actions.filter((a) => a.action.power === 1)).toHaveLength(1);
    // Stamped just BEFORE the call (the publish time is inside it): never later
    // than the publish, and not stale. Exact equality flaked by 1 ms under load.
    const stamp = serverOnMap(collector).get("ac1") ?? 0;
    expect(stamp, "the accepted power publish is the server ON").toBeLessThanOrEqual(publishedAt());
    expect(stamp).toBeGreaterThan(publishedAt() - 1_000);
    const state = (collector as never as { automationState: Map<number, { status: string }> }).automationState.get(1);
    expect(state?.status, "the rule knows the AC was turned on").toBe("triggered");

    // Our ON's dump, then Mom's remote OFF.
    tclCloud.getDevices.mockReturnValue([humanOffDevice(publishedAt())]);
    tclCloud.fetchDevicesLive.mockResolvedValue([humanOffDevice(publishedAt())]);
    await checkAcRange(collector, acRangeRule());

    expect(locks.has("ac1")).toBe(true);
    expect(actions.filter((a) => a.action.power === 1), "no re-send over the human's off").toHaveLength(1);
  });

  it("turn-on timer: the accepted power publish is stamped as the server ON", async () => {
    const { collector, tclCloud, actions } = createCollector();
    const publishedAt = partialExecute(tclCloud, actions);
    acTimers.set("ac1", { deviceId: "ac1", action: "on", fireAt: Date.now() - 1 });

    await (collector as never as { checkAcTimers: () => Promise<void> }).checkAcTimers();

    expect(actions.filter((a) => a.action.power === 1)).toHaveLength(1);
    const stamp = serverOnMap(collector).get("ac1") ?? 0;
    expect(stamp).toBeLessThanOrEqual(publishedAt());
    expect(stamp).toBeGreaterThan(publishedAt() - 1_000);
  });
});
