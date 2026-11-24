// Off when back online vs the collector's automation rules (2026-10-10). The
// armed OFF resolves only in the collector's dedicated "ac-off-when-online"
// step, which collectAll runs right BEFORE "automations", and it is a PLAIN
// server-commanded OFF (owner decision 2026-10-10: the manual-off lock was
// dropped). Two things follow and are pinned here:
//  - L2: a rule that observes that OFF must never read it as a human's and
//    record a lock by the back door (hard rule 2). The step books the OFF at its
//    publish boundary and the observed-off classifier recognises its report,
//    even long after the 15-min power-event window, while a LATER OFF (after an
//    ON) is judged as before.
//  - With no lock, a rule that wants the unit ON may turn it back on, exactly as
//    after any other server OFF.
//
// A REAL collector drives a REAL TclCloud here (only the TCL HTTP/AWS edges and
// the pg pool are faked, as in off-when-online-step.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Persistence stays off disk; nothing in these tests reads it back.
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (path: string) => {
      throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: "ENOENT" });
    }),
    writeFile: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
  };
});

const logLines = vi.hoisted(() => [] as string[]);
vi.mock("./logger.js", () => {
  const capture = (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  };
  return { childLogger: () => ({ info: capture, warn: capture, error: capture, debug: capture }) };
});

import { OFF_WHEN_ONLINE_LEASE_MS, TclCloud, type AcDevice } from "./tcl-cloud.js";
import { Collector } from "./collector.js";
import type { Config } from "./config.js";
import { acTimers } from "./routes.js";

const GUEST = "DlXqDBFAAAE";
/** A whole second, as AWS shadow metadata stamps are. */
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);

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
  tclUsername: "user",
  tclPassword: "pass",
  authSecret: "",
  adminUser: "",
  adminPassword: "",
  hermesApiToken: "",
  observedOffLocks: true,
};

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

interface CollectorSeam {
  initTclCloud: () => Promise<void>;
  checkOffWhenOnline: () => Promise<void>;
  checkScheduleAutomation: (rule: unknown) => Promise<void>;
  checkMetricAutomation: (rule: unknown) => Promise<void>;
  checkAcTimers: () => Promise<void>;
  automationState: Map<number, { status: string }>;
  lastServerAcOnAt: Map<string, number>;
  latestWeatherRow: Record<string, unknown>;
  latestWeatherTs: Date;
  offWhenOnlineOffs: Map<string, Array<{ publishedAt: number; voided: boolean; reportAt: number | null }>>;
}

/** Let the real async plumbing (response bodies, held promises) run. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  if (!condition()) throw new Error("condition not reached");
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

/**
 * A collector wired to a real TclCloud whose Guest unit dropped offline ON an
 * hour ago and was armed at T0 (unless `arm: false`). The last power event was
 * 20 minutes before T0, so the 15-min observed-off power-event window has
 * EXPIRED. `report()` sets the unit's newest report and moves the clock one
 * second past it.
 */
async function setup(options: { arm?: boolean } = {}) {
  /** Every lock INSERT and every publish, in order. */
  const events: string[] = [];
  const inserts: unknown[][] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO ac_manual_off_locks")) {
        inserts.push(params);
        events.push(`lock ${String(params[1])}`);
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const init = vi.spyOn(TclCloud.prototype, "init").mockResolvedValue(undefined);
  const collector = new Collector(pool as never, config);
  const cseam = collector as unknown as CollectorSeam;
  try {
    await cseam.initTclCloud();
  } finally {
    init.mockRestore();
  }
  const tcl = collector.tclCloud!;
  const seam = tcl as unknown as Seam;
  const published: Array<Record<string, unknown>> = [];
  let doc = shadowDoc(1, T0 - 3_600_000);

  seam.tokenData = { saasToken: "t", cognitoToken: "c", cognitoId: "i", mqttEndpoint: "m" };
  seam.authData = { token: "a", refreshToken: "r", username: "u", countryAbbr: "IQ" };
  seam.awsCreds = { accessKeyId: "k", secretKey: "s", sessionToken: "x", expiration: T0 + 3_600_000, region: "eu-central-1" };
  seam.signAwsRequest = () => ({});
  seam.ensureValidTokens = vi.fn(async () => undefined);
  seam.publishShadowUpdate = vi.fn(async (_deviceId: string, desired: Record<string, unknown>) => {
    published.push(desired);
    events.push(`publish ${String(desired.powerSwitch)}`);
  });
  seam.controlVerifyDelay = () => new Promise<void>(() => undefined); // park any user verifier
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("user_groups/get")) {
      return new Response(JSON.stringify({
        code: 0,
        data: [{ devices: [{ deviceId: GUEST, nickName: "guest", isOnline: "1" }] }],
      }));
    }
    return new Response(JSON.stringify(doc));
  }));

  seam.cachedDevices = await seam.fetchDevices(); // nothing armed yet
  seam.lastState = {}; // no saved-state restore after an ON: the publish list holds only commands
  vi.setSystemTime(T0 - 20 * 60_000);
  collector.notePowerEvent("source gen → grid"); // long before the arm
  vi.setSystemTime(T0);
  if (options.arm !== false) void tcl.setOffWhenOnline(GUEST, true); // armedAt = T0
  published.length = 0;
  events.length = 0;
  logLines.length = 0;

  return {
    collector,
    cseam,
    tcl,
    seam,
    inserts,
    events,
    published,
    /** The unit's newest report at `secFromT0`, and the clock one second later. */
    report(power: 0 | 1, secFromT0: number): void {
      doc = shadowDoc(power, T0 + secFromT0 * 1000);
      vi.setSystemTime(T0 + (secFromT0 + 1) * 1000);
    },
    at(msFromT0: number): void {
      vi.setSystemTime(T0 + msFromT0);
    },
    indoor(tempC: number): void {
      cseam.latestWeatherRow = { temp_indoor_c: tempC };
      cseam.latestWeatherTs = new Date();
    },
    /** The off-when-online step: collectAll runs it right before "automations". */
    async step(): Promise<void> {
      await cseam.checkOffWhenOnline();
    },
  };
}

/** A schedule whose window holds the (fake) current Baghdad minute and the next half hour. */
function activeScheduleRule() {
  const baghdadNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Baghdad" }));
  const fmt = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return {
    id: 7,
    name: "Guest schedule",
    enabled: true,
    automation_type: "schedule",
    device_type: "ac",
    metric: null,
    condition: null,
    threshold: null,
    threshold_low: null,
    time_start: fmt(new Date(baghdadNow.getTime() - 60_000)),
    time_end: fmt(new Date(baghdadNow.getTime() + 30 * 60_000)),
    device_id: GUEST,
    device_name: "Guest",
    device_ids: [GUEST],
    device_names: ["Guest"],
    turn_off_at_end: false,
    sustained_minutes: 0,
    start_mode: "exact",
    start_prayer: null,
    start_prayer_offset: null,
    end_mode: "exact",
    end_prayer: null,
    end_prayer_offset: null,
    action_on: { power: 1 },
    action_off: { power: 0 },
    cooldown_secs: 0,
    range_slots: null,
  };
}

/** A plain (non-range) metric rule that wants Guest ON while it is hot indoors, OFF when it clears. */
function hotMetricRule() {
  return {
    ...activeScheduleRule(),
    id: 8,
    name: "Guest heat",
    automation_type: "metric",
    metric: "temp_indoor_c",
    condition: "above",
    threshold: 26,
    time_start: null,
    time_end: null,
    turn_off_at_end: true,
  };
}

const ownOffLine = (line: string) => line.includes(`device ${GUEST}`) && line.includes("off-when-back-online OFF");

beforeEach(() => {
  logLines.length = 0;
  acTimers.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  acTimers.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("L2: the deferred OFF is a server OFF, never a human's (no lock by the back door)", () => {
  it("a triggered metric rule observes our OFF with the power-event window expired: no lock, and the rule stands down", async () => {
    const s = await setup();
    const rule = hotMetricRule();
    s.report(1, 5); // back, and ON
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule); // its ordinary first trigger: ON
    expect(s.cseam.automationState.get(rule.id)?.status).toBe("triggered");

    s.at(7_000);
    await s.step(); // our deferred OFF
    expect(s.events).toEqual(["publish 1", "publish 0"]);

    s.report(0, 8); // our OFF landed
    s.at(200_000); // past the rule ON's 120 s shadow-lag grace, 23 min after the last power event
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule); // triggered and still hot: it observes the OFF

    expect(s.inserts).toEqual([]);
    expect(logLines.some(ownOffLine)).toBe(true);
    expect(s.events).toEqual(["publish 1", "publish 0"]); // and no re-ON over it
  });

  it("a triggered schedule observes our OFF: no lock; with no lock, its window then turns the unit back on as after any server OFF", async () => {
    const s = await setup({ arm: false });
    const rule = activeScheduleRule();
    s.report(0, -60); // a minute before the arm the unit was OFF in the schedule's window
    await s.cseam.checkScheduleAutomation(rule); // so the schedule switched it ON
    expect(s.cseam.automationState.get(rule.id)?.status).toBe("triggered");
    s.report(1, -55); // its ON landed; then the Guest line dropped with the unit ON
    s.at(0);
    void s.tcl.setOffWhenOnline(GUEST, true); // armed at T0

    s.report(1, 30); // back, and ON
    await s.step(); // our deferred OFF
    s.report(0, 33); // our OFF landed
    s.at(200_000);
    await s.cseam.checkScheduleAutomation(rule); // triggered: observes the OFF

    expect(s.inserts).toEqual([]);
    expect(logLines.some(ownOffLine)).toBe(true);
    expect(s.cseam.automationState.get(rule.id)?.status).toBe("idle");

    s.at(205_000);
    await s.cseam.checkScheduleAutomation(rule); // idle inside its window, the unit OFF and unlocked
    expect(s.events).toEqual(["publish 1", "publish 0", "publish 1"]);
    expect(s.inserts).toEqual([]);
  });

  it("a later OFF after a human ON is judged as before: the booking covers only our OFF's own report", async () => {
    const s = await setup();
    const rule = hotMetricRule();
    s.report(1, 5);
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule);
    s.at(7_000);
    await s.step();
    s.report(0, 8);
    s.at(200_000);
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule); // ours: no lock
    expect(s.inserts).toEqual([]);

    s.report(1, 300); // switched back on by hand
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule);
    s.report(0, 400); // and off again with the remote, still within 15 min of our OFF
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule);

    expect(s.inserts).toEqual([[GUEST, "observed_off"]]);
  });

  it("our OFF ended by a dashboard poll's fetch: the next step pins it, so a rule observing it half an hour later still records no lock", async () => {
    const s = await setup();
    const rule = hotMetricRule();
    s.report(1, 5);
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule); // triggered: ON
    s.at(7_000);
    await s.step(); // our deferred OFF

    s.report(0, 8); // our OFF landed
    await s.tcl.fetchDevicesLive(); // an open dashboard's poll: its fetch ends the arm
    expect(s.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    s.at(10_000);
    await s.step(); // nothing armed: it only pins the OFF that fetch saw

    s.at(30 * 60_000); // long past the 15-min shadow-lag allowance of an unmatched booking
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule);

    expect(s.inserts).toEqual([]);
    expect(logLines.some(ownOffLine)).toBe(true);
  });
});

describe("S2: a booking never outlives a rejected publish or its own expiry", () => {
  it("every OFF publish rejected, the arm gives up, then a human OFF outside the power-event window: the normal manual classification (observed_off lock)", async () => {
    const s = await setup();
    const rule = hotMetricRule();
    s.report(1, 5); // back, and ON
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule); // triggered: ON
    s.seam.publishShadowUpdate = vi.fn(async (_deviceId: string, desired: Record<string, unknown>) => {
      if (desired.powerSwitch === 0) throw new Error("cloud down");
      s.published.push(desired);
      s.events.push(`publish ${String(desired.powerSwitch)}`);
    });

    for (let t = 7_000; t <= 67_000; t += 15_000) {
      s.at(t);
      await s.step(); // 4 rejected sends 15 s apart, then the give-up
    }
    expect(s.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(logLines.some((line) => line.includes("gave up"))).toBe(true);

    s.report(0, 300); // a hand on the remote, 4 min after the last rejected send
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule); // triggered and hot: observes the OFF

    expect(s.inserts).toEqual([[GUEST, "observed_off"]]);
    expect(logLines.some(ownOffLine)).toBe(false);
  });

  it("an unmatched booking first presented with an OFF after its expiry is not ours: the step never pins it", async () => {
    const s = await setup();
    const rule = hotMetricRule();
    s.report(1, 5);
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule); // triggered: ON
    s.at(7_000);
    await s.step(); // our OFF, accepted and booked at 7 s
    expect(s.events).toEqual(["publish 1", "publish 0"]);

    s.at(10_000);
    s.collector.notePowerEvent("source grid → gen"); // the line died before our OFF showed: an epoch
    for (let t = 25_000; t <= 20 * 60_000; t += 5 * 60_000) {
      s.at(t);
      await s.step(); // the 5 s report predates the epoch: nothing sent
    }
    expect(s.events).toEqual(["publish 1", "publish 0"]);

    s.report(0, 20 * 60 + 30); // 20 min later the unit is back, reporting OFF (no power event noted)
    await s.step(); // its fetch ends the arm; the booking is 20 min old and unmatched: dropped, never pinned
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule); // 20 min after the last power event: outside its window

    expect(s.inserts).toEqual([[GUEST, "observed_off"]]);
    expect(logLines.some(ownOffLine)).toBe(false);
  });
});

describe("R1: an operation's rollback voids only its own publish records, never a newer accepted OFF's", () => {
  /** The TCL session, as setup() seeds it (a 403 drops it; another caller's re-auth restores it). */
  function restoreSession(s: Awaited<ReturnType<typeof setup>>): void {
    s.seam.tokenData = { saasToken: "t", cognitoToken: "c", cognitoId: "i", mqttEndpoint: "m" };
    s.seam.awsCreds = { accessKeyId: "k", secretKey: "s", sessionToken: "x", expiration: T0 + 3_600_000, region: "eu-central-1" };
  }

  it("an operation held in its re-auth after a 403 past its lease, a takeover's OFF accepted, then the old one released (superseded): the accepted record survives and that OFF records no lock outside every other grace window", async () => {
    const s = await setup();
    const rule = hotMetricRule();
    s.report(1, 5); // back, and ON
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule); // triggered: ON (a server ON at 6 s)
    let offPublishes = 0;
    s.seam.publishShadowUpdate = vi.fn(async (_deviceId: string, desired: Record<string, unknown>) => {
      if (desired.powerSwitch === 0 && ++offPublishes === 1) throw new Error("403 Forbidden");
      s.published.push(desired);
      s.events.push(`publish ${String(desired.powerSwitch)}`);
    });
    const reauth = { held: false, release: () => undefined as void };
    s.seam.ensureValidTokens = vi.fn(() => {
      // Only the re-auth after the 403 waits: sendControl dropped the session before it.
      if (s.seam.tokenData != null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        reauth.held = true;
        reauth.release = resolve;
      });
    });

    s.at(7_000);
    const old = s.step(); // its OFF publish is refused (403), then its re-auth hangs
    await until(() => reauth.held);
    restoreSession(s); // another caller's re-auth restored the session meanwhile
    s.at(7_000 + OFF_WHEN_ONLINE_LEASE_MS + 1_000); // the old operation's lease ran out
    await s.step(); // a new operation takes the device over: its OFF is ACCEPTED
    expect(s.events).toEqual(["publish 1", "publish 0"]);
    reauth.release();
    await old; // its retry fails the claim guard: superseded, and it rolls back its own publish

    s.report(0, 130); // the takeover's OFF landed
    s.at(200_000); // past the rule ON's 120 s shadow-lag grace, 23 min after the last power event
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule); // triggered and still hot: it observes the OFF

    expect(s.events).toEqual(["publish 1", "publish 0"]);
    expect(s.inserts).toEqual([]);
    expect(logLines.some(ownOffLine)).toBe(true);
  });

  it("an operation whose OFF publish hangs past its lease and is then rejected, after a takeover's OFF was accepted: the accepted record survives and that OFF records no lock", async () => {
    const s = await setup();
    const rule = hotMetricRule();
    s.report(1, 5);
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule); // triggered: ON
    const hung = { held: false, reject: (_err: Error) => undefined as void };
    let offPublishes = 0;
    s.seam.publishShadowUpdate = vi.fn((_deviceId: string, desired: Record<string, unknown>) => {
      if (desired.powerSwitch === 0 && ++offPublishes === 1) {
        return new Promise<void>((_resolve, reject) => {
          hung.held = true;
          hung.reject = reject;
        });
      }
      s.published.push(desired);
      s.events.push(`publish ${String(desired.powerSwitch)}`);
      return Promise.resolve();
    });

    s.at(7_000);
    const old = s.step(); // its OFF publish hangs
    await until(() => hung.held);
    s.at(7_000 + OFF_WHEN_ONLINE_LEASE_MS + 1_000);
    await s.step(); // the takeover's OFF is accepted
    expect(s.events).toEqual(["publish 1", "publish 0"]);
    hung.reject(new Error("socket hang up")); // the old publish finally fails: a rejection
    await old;

    s.report(0, 130); // the takeover's OFF landed
    s.at(200_000);
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule);

    expect(s.inserts).toEqual([]);
    expect(logLines.some(ownOffLine)).toBe(true);
  });
});

describe("D1: an OFF report is pinned to, and classified by, only a record published at or before it", () => {
  it("a refused OFF publish, its re-auth retry held in flight, a human OFF dated before the retry seen and classified meanwhile, then the retry accepted: the retry stays unmatched and that OFF gets the normal manual classification (observed_off lock)", async () => {
    const s = await setup();
    const rule = hotMetricRule();
    s.report(1, 5); // back, and ON
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule); // triggered: ON (a server ON at 6 s)
    const retry = { held: false, release: () => undefined as void };
    let offPublishes = 0;
    s.seam.publishShadowUpdate = vi.fn((_deviceId: string, desired: Record<string, unknown>) => {
      if (desired.powerSwitch === 0 && ++offPublishes === 1) return Promise.reject(new Error("403 Forbidden"));
      if (desired.powerSwitch === 0) {
        return new Promise<void>((resolve) => {
          retry.held = true; // the retry's publish is in flight: its guard passed, the cloud has not answered
          retry.release = () => {
            s.published.push(desired);
            s.events.push("publish 0");
            resolve();
          };
        });
      }
      s.published.push(desired);
      s.events.push(`publish ${String(desired.powerSwitch)}`);
      return Promise.resolve();
    });
    s.seam.ensureValidTokens = vi.fn(async () => {
      if (s.seam.tokenData != null) return;
      s.at(8_000); // the re-auth after the 403 takes a second: the retry publishes at 8 s
      s.seam.tokenData = { saasToken: "t", cognitoToken: "c", cognitoId: "i", mqttEndpoint: "m" };
      s.seam.awsCreds = { accessKeyId: "k", secretKey: "s", sessionToken: "x", expiration: T0 + 3_600_000, region: "eu-central-1" };
    });

    s.at(7_000);
    const stepping = s.step(); // its OFF publish at 7 s is refused (403); the retry at 8 s hangs in flight
    await until(() => retry.held);
    s.report(0, 7); // a hand on the remote at 7 s, before the retry was published
    await s.tcl.fetchDevicesLive(); // a dashboard poll sees it: the arm ends
    await s.step(); // nothing armed: it classifies and pins the OFF that fetch saw
    retry.release(); // the cloud accepts the retry
    await stepping;

    const records = s.cseam.offWhenOnlineOffs.get(GUEST) ?? [];
    expect(records.find((record) => record.publishedAt === T0 + 7_000)).toMatchObject({ voided: true });
    expect(records.find((record) => record.publishedAt === T0 + 8_000)).toMatchObject({ voided: false, reportAt: null });

    s.at(200_000); // past the rule ON's 120 s shadow-lag grace, 23 min after the last power event
    s.indoor(28);
    await s.cseam.checkMetricAutomation(rule); // triggered and still hot: it observes the OFF

    expect(s.inserts).toEqual([[GUEST, "observed_off"]]);
    expect(logLines.some(ownOffLine)).toBe(false);
  });
});

describe("P2: a pinned record stays while newer records are pinned, so our older OFF presented again late is still ours", () => {
  it("one arm and two accepted OFF sends: presenting R1, R2 and then R1 again never creates a lock or lock push", async () => {
    const s = await setup();
    const pushes: string[] = [];
    (s.collector as never as { broadcastPush: (p: { title?: string }) => Promise<void> }).broadcastPush = async (p) => {
      pushes.push(String(p.title));
    };
    const first = hotMetricRule();
    const second = { ...hotMetricRule(), id: 9, name: "Guest heat 2" };
    const last = { ...hotMetricRule(), id: 10, name: "Guest heat 3" };
    s.report(1, 5); // back, and ON
    s.indoor(28);
    for (const rule of [first, second, last]) await s.cseam.checkMetricAutomation(rule); // each triggers: ON (server ONs at 6 s)

    s.at(7_000);
    await s.step(); // P1: our OFF at 7 s, accepted
    s.at(21_000);
    await s.tcl.fetchDevicesLive(); // the cloud still reports the old ON
    s.at(22_000);
    await s.step(); // P2: the same arm resends at 22 s, accepted
    expect(s.events.filter((event) => event === "publish 0")).toHaveLength(2);
    expect(s.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);

    s.at(23_000);
    s.report(0, 8);
    await s.cseam.checkMetricAutomation(first); // R1 ends the arm: pinned to P1 (P2 came later)
    expect(s.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(s.inserts).toEqual([]);
    expect(pushes).toEqual([]);
    expect(logLines.filter(ownOffLine)).toHaveLength(1);

    s.report(0, 24); // R2: P2's OFF report at 24 s
    s.at(30_000);
    await s.cseam.checkMetricAutomation(second); // a rule observes R2: pinned to P2
    expect(s.inserts).toEqual([]);
    expect(pushes).toEqual([]);
    expect(logLines.filter(ownOffLine)).toHaveLength(2);

    s.at(200_000); // past the rule ONs' 120 s shadow-lag grace, 23 min after the last power event
    s.report(0, 8); // a later poll presents R1 again
    await s.cseam.checkMetricAutomation(last);
    expect(s.inserts).toEqual([]);
    expect(pushes).toEqual([]);
    expect(logLines.filter(ownOffLine)).toHaveLength(3);
  });
});

describe("the rules around the step: a fetch only observes, the step's OFF carries no lock", () => {
  it("a cold-cache metric rule run alone: its own device fetch resolves nothing, and the ON it books is the ON it sent", async () => {
    const s = await setup();
    const rule = hotMetricRule();
    s.report(1, 5); // the unit is back and reporting ON
    s.seam.cachedDevices = []; // e.g. init's fetch failed: the rule's cache fill is the first fetch
    s.indoor(28);

    await s.cseam.checkMetricAutomation(rule);

    expect(s.inserts).toEqual([]);
    expect(s.published).toEqual([{ powerSwitch: 1 }]);
    expect(s.cseam.automationState.get(rule.id)?.status).toBe("triggered");
    expect(s.cseam.lastServerAcOnAt.has(GUEST)).toBe(true);
    expect(s.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);

    // The next tick's step resolves the arm: a plain OFF.
    s.at(11_000);
    await s.step();
    expect(s.events).toEqual(["publish 1", "publish 0"]);
  });

  it("in loop order the step's OFF goes out before the automations; with no lock, a rule that wants the unit ON runs as usual", async () => {
    const s = await setup();
    const rule = hotMetricRule();
    s.report(1, 5);
    s.indoor(28);

    await s.step();
    await s.cseam.checkMetricAutomation(rule); // idle and hot: its ordinary first trigger

    expect(s.events).toEqual(["publish 0", "publish 1"]);
    expect(s.inserts).toEqual([]);
  });

  it("the unit came back already OFF: the step sends nothing and leaves no lock, so a due turn-on timer fires", async () => {
    const s = await setup();
    s.report(0, 5);
    s.seam.cachedDevices = [];
    acTimers.set(GUEST, { deviceId: GUEST, action: "on", fireAt: T0 });

    await s.step();
    await s.cseam.checkAcTimers();

    expect(s.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(s.inserts).toEqual([]);
    expect(s.published).toEqual([{ powerSwitch: 1 }]);
  });
});
