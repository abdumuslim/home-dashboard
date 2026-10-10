// "Turn off once back online" (owner request 2026-10-09): the collector's
// dedicated off-when-online step. A device fetch only observes; the step runs
// right before "automations" in collectAll and sends a PLAIN server-commanded
// OFF (owner decision 2026-10-10: the manual-off lock was tried and dropped the
// same day after review). No lock is read, recorded or cleared anywhere on the
// feature path. On top of the reviewed structure: an OFF any fetch sees ends
// the arm at once, durably (L3, S1, S4), a real source transition is a power
// epoch (L4), the per-device operation claim has a token and a lease (L5), the
// publish guard re-checks the arm, the claim and the gated epoch (S1), each
// publish has its own record and a publish the cloud did not accept voids only
// that record, never another operation's (S2, R1), and an armed step drives
// the TCL re-auth even when no automation rule exists (L8).
//
// A REAL Collector drives a REAL TclCloud: only the TCL HTTP/AWS edges and the
// pg pool are faked. Only Date is faked; real setImmediate keeps the async
// plumbing flowing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fs/promises is mocked so the arm file never touches /app/data. readFile
// serves `files` (ENOENT otherwise), writeFile stores into it, rename moves an
// entry (the arm file is written to a temp file, then renamed over it).
const fsMock = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return {
    ...actual,
    readFile: vi.fn(async (path: string) => {
      const content = fsMock.files.get(String(path));
      if (content == null) throw enoent(String(path));
      return content;
    }),
    writeFile: vi.fn(async (path: string, data: string) => {
      fsMock.files.set(String(path), String(data));
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const data = fsMock.files.get(String(from));
      if (data == null) throw enoent(String(from));
      fsMock.files.delete(String(from));
      fsMock.files.set(String(to), data);
    }),
  };
});

const logSpy = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./logger.js", () => ({ childLogger: () => logSpy }));

import { OFF_WHEN_ONLINE_LEASE_MS, SHADOW_STALE_MS, TclCloud, type AcDevice, type OffWhenOnlineArm } from "./tcl-cloud.js";
import { Collector } from "./collector.js";
import type { Config } from "./config.js";

const GUEST = "DlXqDBFAAAE";
const OFF_FILE = "/app/data/ac-off-when-online.json";
/** A whole second, as AWS shadow metadata stamps are. */
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const RESEND_MS = 15_000;
const REASON = "cancelled by direct user power command";

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

interface TclSeam {
  tokenData: unknown;
  authData: unknown;
  awsCreds: unknown;
  signAwsRequest: () => Record<string, string>;
  ensureValidTokens: () => Promise<void>;
  publishShadowUpdate: (deviceId: string, desired: Record<string, unknown>) => Promise<void>;
  controlVerifyDelay: () => Promise<void>;
  cachedDevices: AcDevice[];
  lastState: Record<string, Record<string, unknown>>;
  pendingOffWhenOnline: Map<string, OffWhenOnlineArm>;
  fetchDevices: () => Promise<AcDevice[]>;
}

interface CollectorSeam {
  initTclCloud: () => Promise<void>;
  checkOffWhenOnline: () => Promise<void>;
  offWhenOnlineOffs: Map<string, OffRecord[]>;
}

/** One OFF publish record of the collector's (`offWhenOnlineOffs`). */
interface OffRecord {
  id: number;
  publishedAt: number;
  voided: boolean;
  reportAt: number | null;
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

/** Let the real async plumbing (response bodies, pending queries) run. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  if (!condition()) throw new Error("condition not reached");
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface SetupOptions {
  /** Persisted arm-file content read at construction. */
  armFile?: Record<string, unknown>;
}

async function setup(options: SetupOptions = {}) {
  if (options.armFile) fsMock.files.set(OFF_FILE, JSON.stringify(options.armFile));
  /** One ordered log of publishes and suspensions. */
  const events: string[] = [];
  /** Every statement that touched the manual-off lock store, in order. */
  const lockSql: string[] = [];
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("ac_manual_off_locks")) lockSql.push(sql.trim().split(/\s+/)[0]);
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
  const seam = tcl as unknown as TclSeam;
  if (options.armFile) await until(() => seam.pendingOffWhenOnline.size > 0);

  const published: Array<Record<string, unknown>> = [];
  let doc = shadowDoc(1, T0 - 3_600_000); // the stale shadow of a unit that dropped offline ON
  let tclOnline = true;
  let groupFetches = 0;
  seam.tokenData = { saasToken: "t", cognitoToken: "c", cognitoId: "i", mqttEndpoint: "m" };
  seam.authData = { token: "a", refreshToken: "r", username: "u", countryAbbr: "IQ" };
  seam.awsCreds = { accessKeyId: "k", secretKey: "s", sessionToken: "x", expiration: T0 + 3_600_000, region: "eu-central-1" };
  seam.signAwsRequest = () => ({});
  seam.ensureValidTokens = vi.fn(async () => undefined);
  seam.publishShadowUpdate = vi.fn(async (_deviceId: string, desired: Record<string, unknown>) => {
    events.push(desired.powerSwitch === 0 ? "publish-off" : "publish");
    published.push(desired);
  });
  seam.controlVerifyDelay = () => new Promise<void>(() => undefined); // park any user verifier
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("user_groups/get")) {
      groupFetches += 1;
      return new Response(JSON.stringify({
        code: 0,
        data: [{ devices: [{ deviceId: GUEST, nickName: "guest", isOnline: tclOnline ? "1" : "0" }] }],
      }));
    }
    return new Response(JSON.stringify(doc));
  }));

  // Seed the device cache as init would (the cache time stays 0, so the
  // step's first snapshot is a live fetch). Nothing armed yet: nothing to do.
  seam.cachedDevices = await seam.fetchDevices();
  seam.lastState = {}; // no saved-state restore after a user ON: only commands are published
  published.length = 0;
  events.length = 0;
  groupFetches = 0;

  return {
    collector,
    tcl,
    seam,
    events,
    lockSql,
    published,
    groupFetches: () => groupFetches,
    arm(): void {
      void tcl.setOffWhenOnline(GUEST, true);
    },
    /** The unit's newest report, `secFromT0` seconds after T0 (the arm time). */
    report(power: 0 | 1, secFromT0: number): void {
      doc = shadowDoc(power, T0 + secFromT0 * 1000);
    },
    reportWithoutMetadata(power: 0 | 1): void {
      doc = { state: { reported: (shadowDoc(power, T0).state as { reported: object }).reported } };
    },
    setTclOnline(value: boolean): void {
      tclOnline = value;
    },
    at(msFromT0: number): void {
      vi.setSystemTime(T0 + msFromT0);
    },
    /** The collector's dedicated off-when-online loop step. */
    async step(): Promise<void> {
      await cseam.checkOffWhenOnline();
    },
    /** Park the next token wait until `release()`. */
    holdNextTokenWait() {
      const hold = { held: false, release: () => undefined as void };
      let used = false;
      seam.ensureValidTokens = vi.fn(() => {
        if (used) return Promise.resolve();
        used = true;
        return new Promise<void>((resolve) => {
          hold.held = true;
          events.push("tokens-held");
          hold.release = resolve;
        });
      });
      return hold;
    },
    entry(): OffWhenOnlineArm | undefined {
      return seam.pendingOffWhenOnline.get(GUEST);
    },
    offs(): number {
      return published.filter((p) => p.powerSwitch === 0).length;
    },
    /** The collector's records of our own OFF publishes for Guest (`offWhenOnlineOffs`), voided ones included until pruned. */
    records(): OffRecord[] {
      return cseam.offWhenOnlineOffs.get(GUEST) ?? [];
    },
    /** The startup read of the arm file has settled. */
    async loaded(): Promise<void> {
      await (tcl as unknown as { offWhenOnlineLoaded: Promise<void> }).offWhenOnlineLoaded;
    },
  };
}

beforeEach(() => {
  fsMock.files.clear();
  logSpy.info.mockClear();
  logSpy.warn.mockClear();
  logSpy.error.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the device fetch sends nothing", () => {
  it("armed, fresh online ON report: a real device fetch publishes no OFF and leaves the arm untouched", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);

    const [dev] = await h.tcl.fetchDevicesLive();
    h.seam.cachedDevices = []; // the cache-fill path every executeAcAction caller can take
    await h.tcl.ensureDeviceCachePopulated();
    await settle();

    expect(h.published).toEqual([]);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);
    expect(h.entry()).toMatchObject({ attempts: 0 });
    expect(dev.offWhenOnline).toBe(true);
  });

  it("a fresh OFF report fetched while armed ends the arm at once (arm state only): nothing sent, no lock, the removal persisted", async () => {
    const h = await setup();
    h.arm();
    h.report(0, 5);
    h.at(6_000);

    await h.tcl.fetchDevicesLive();
    await settle();

    expect(h.published).toEqual([]);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({});
    expect(h.lockSql).toEqual([]);
  });
});

describe("L1: the feature never touches the manual-off lock store", () => {
  it("arm, gate no-ops, sends, resends, give-up, re-arm, an epoch, came-back-OFF and both cancels: no lock read, write, clear or recorder call", async () => {
    const h = await setup();
    const record = vi.spyOn(h.collector, "recordAcManualOff");
    const clear = vi.spyOn(h.collector, "clearAcManualOff");
    const locked = vi.spyOn(h.collector, "isAcManualOffLocked");

    h.arm();
    h.report(1, 0); // the arm's own second: the gate holds
    h.at(1_000);
    await h.step();
    h.report(1, 5); // back ON: four sends 15 s apart, then a loud give-up
    for (let t = 6_000; t <= 90_000; t += 5_000) {
      h.at(t);
      await h.step();
    }
    expect(h.offs()).toBe(4);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);

    h.at(200_000);
    h.arm(); // re-armed
    h.collector.notePowerEvent("source grid → gen"); // a power epoch
    h.report(0, 260); // back, already OFF: done, nothing sent
    h.at(261_000);
    await h.step();
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);

    h.arm();
    h.tcl.cancelOffWhenOnline(GUEST, REASON);
    h.arm();
    await h.tcl.setOffWhenOnline(GUEST, false);
    await settle();

    expect(h.offs()).toBe(4);
    expect(record).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(locked).not.toHaveBeenCalled();
    expect(h.lockSql).toEqual([]); // no SELECT, INSERT or DELETE on ac_manual_off_locks
  });
});

describe("the step: gate (online by the loop's own rule AND strictly newer than the arm)", () => {
  it("not newer than the arm, without metadata, or stale while TCL says offline: nothing sent or spent", async () => {
    const h = await setup();
    h.arm(); // armedAt = T0

    h.report(1, 0); // same second as the arm
    h.at(1_000);
    await h.step();
    h.report(1, -30); // older than the arm
    h.at(20_000);
    await h.step();
    h.reportWithoutMetadata(1); // reportedAt null
    h.at(40_000);
    await h.step();
    h.setTclOnline(false);
    h.report(1, 50); // a brief post-arm report, then the line dropped again
    h.at(50_000 + SHADOW_STALE_MS + 1_000); // that report is now past the freshness window
    await h.step();

    expect(h.published).toEqual([]);
    expect(h.entry()).toMatchObject({ attempts: 0 });
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);

    h.report(1, 50 + SHADOW_STALE_MS / 1000 + 14); // the unit really returns
    h.at(50_000 + SHADOW_STALE_MS + 15_000); // the last snapshot is 14 s old: refreshed
    await h.step();
    expect(h.events).toEqual(["publish-off"]);
  });

  it("with nothing armed the step neither fetches the devices nor touches the lock store", async () => {
    const h = await setup();
    h.at(30_000);

    await h.step();

    expect(h.groupFetches()).toBe(0);
    expect(h.lockSql).toEqual([]);
  });

  it("reuses a snapshot up to 10 s old and fetches a live one when it is older", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.tcl.fetchDevicesLive(); // another step's fetch, at 6 s
    expect(h.groupFetches()).toBe(1);

    h.at(16_000); // 10 s old: reused
    await h.step();
    expect(h.groupFetches()).toBe(1);
    expect(h.offs()).toBe(1);

    h.at(31_000); // 15 s old: refreshed
    await h.step();
    expect(h.groupFetches()).toBe(2);
  });
});

describe("the step: a plain server OFF", () => {
  it("sends the OFF on the first fresh ON report, with no lock first", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);

    await h.step();

    expect(h.events).toEqual(["publish-off"]);
    expect(h.published).toEqual([{ powerSwitch: 0 }]);
    expect(h.lockSql).toEqual([]);
    // Still armed: it resolves when the unit reports OFF.
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);
    expect(h.entry()).toMatchObject({ attempts: 1, lastSentAt: T0 + 6_000 });
    // The accepted publish keeps its record (the observed-off classifier's "ours").
    expect(h.records()).toEqual([{ id: expect.any(Number), publishedAt: T0 + 6_000, voided: false, reportAt: null }]);
  });

  it("the line coming back is a power epoch: the report after it fires the same plain OFF (the changeover's restore is refused)", async () => {
    const h = await setup();
    h.arm();
    h.collector.notePowerEvent("source gen → grid"); // the line comes back
    expect(logSpy.warn).toHaveBeenCalledWith(expect.stringContaining(`Refusing last-state restore for ${GUEST}: off-when-back-online is armed`));
    h.report(1, 5);
    h.at(6_000);

    await h.step();

    expect(h.events).toEqual(["publish-off"]);
    expect(h.lockSql).toEqual([]);
  });

  it("resends every 15 s while ON and gives up loudly after 4 sends", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    for (let t = 6_000; t <= 6_000 + 3 * RESEND_MS; t += 5_000) {
      h.at(t);
      await h.step();
    }
    expect(h.offs()).toBe(4);

    h.at(6_000 + 4 * RESEND_MS - 1); // 15 s not yet elapsed since the 4th send
    await h.step();
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);

    h.at(6_000 + 4 * RESEND_MS);
    await h.step();
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(logSpy.warn).toHaveBeenCalledWith(expect.stringContaining("gave up"));

    h.at(6_000 + 6 * RESEND_MS);
    await h.step();
    expect(h.offs()).toBe(4);
  });
});

describe("the step: the unit reports OFF (L3: any OFF seen after our send is terminal)", () => {
  it("came back already OFF: done, nothing sent", async () => {
    const h = await setup();
    h.arm();
    h.report(0, 5);
    h.at(6_000);

    await h.step();

    expect(h.published).toEqual([]);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(h.entry()).toBeUndefined();
    expect(logSpy.info).toHaveBeenCalledWith(expect.stringContaining("done"));
  });

  it("our OFF landed: done, no second send", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.step();
    expect(h.offs()).toBe(1);

    h.report(0, 8); // the unit applied our OFF
    h.at(21_000);
    await h.step();

    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(h.offs()).toBe(1);
  });

  it("an OFF that another fetch saw between steps, then ON again (switched back on): done, no further OFF over that ON", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.step();
    expect(h.offs()).toBe(1);

    h.report(0, 8); // our OFF landed; an open dashboard's poll sees it, the step does not
    h.at(9_000);
    await h.tcl.fetchDevicesLive();
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false); // that poll's fetch ended the arm
    h.report(1, 20); // then someone switched it back on
    h.at(25_000); // past the resend spacing: the old step would answer this ON with another OFF
    await h.step();

    expect(h.offs()).toBe(1);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(logSpy.info).toHaveBeenCalledWith(expect.stringContaining(`Off-when-back-online for ${GUEST} done`));
    expect(h.records().map((record) => record.reportAt)).toEqual([T0 + 8_000]); // the step pinned the OFF that fetch saw as ours
  });

  it("an OFF reported between two of our sends and seen only after the second, then ON again: done, no third OFF", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.step(); // send 1
    h.at(21_000);
    await h.step(); // still reads ON: send 2
    expect(h.offs()).toBe(2);

    h.report(0, 15); // send 1 had landed at 15 s; a dashboard poll sees it only now
    h.at(22_000);
    await h.tcl.fetchDevicesLive();
    h.report(1, 30); // then someone switched it back on
    h.at(40_000);
    await h.step();

    expect(h.offs()).toBe(2);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
  });

  it("the snapshot whose fetch saw the OFF already shows the arm gone; the step then finds nothing to do", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    const [before] = await h.tcl.fetchDevicesLive();
    expect(before.offWhenOnline).toBe(true);
    h.report(0, 6);
    h.at(7_000);

    const [after] = await h.tcl.fetchDevicesLive();
    await h.step();

    expect(after.offWhenOnline).toBe(false);
    expect(h.published).toEqual([]);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
  });
});

describe("S1: the publish guard re-checks eligibility after every await", () => {
  it("an OFF held before publication, then a fetch sees the unit OFF and then ON (switched back on): the release publishes nothing and books nothing", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.tcl.fetchDevicesLive(); // a fresh snapshot, so the only token wait left is the OFF's own
    const hold = h.holdNextTokenWait();

    const stepping = h.step();
    await until(() => hold.held);
    h.report(0, 8); // a hand on the remote, seen by a dashboard poll
    h.at(9_000);
    await h.tcl.fetchDevicesLive();
    h.report(1, 12); // and switched back on: they win
    h.at(13_000);
    await h.tcl.fetchDevicesLive();
    hold.release();
    await stepping;

    expect(h.published).toEqual([]);
    expect(h.records()).toEqual([]);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
  });

  it("an OFF held before publication, then a power epoch with no newer report: the release publishes nothing and books nothing", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.tcl.fetchDevicesLive();
    const hold = h.holdNextTokenWait();

    const stepping = h.step();
    await until(() => hold.held);
    h.at(8_000);
    h.collector.notePowerEvent("source grid → gen"); // the line died again: the 5 s report gated a dead epoch
    hold.release();
    await stepping;

    expect(h.published).toEqual([]);
    expect(h.records()).toEqual([]);
    expect(h.entry()).toMatchObject({ epochAt: T0 + 8_000, attempts: 0, lastSentAt: 0 });
  });
});

describe("S2: only a publish the cloud accepted keeps a live record", () => {
  it("a rejected publish voids its own record (the send still counts toward the give-up)", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    h.seam.publishShadowUpdate = vi.fn(async () => {
      throw new Error("cloud down");
    });

    await h.step();

    expect(h.records()).toEqual([{ id: expect.any(Number), publishedAt: T0 + 6_000, voided: true, reportAt: null }]);
    expect(h.entry()).toMatchObject({ attempts: 1, lastSentAt: T0 + 6_000 });
  });

  it("a resend that is rejected voids only its own record: the accepted send's record is left as it was", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.step(); // accepted
    const [accepted] = h.records();
    const before = { ...accepted };
    h.seam.publishShadowUpdate = vi.fn(async () => {
      throw new Error("cloud down");
    });

    h.at(21_000);
    await h.step(); // still ON: the resend is rejected

    expect(h.records()).toEqual([before, { id: expect.any(Number), publishedAt: T0 + 21_000, voided: true, reportAt: null }]);
    expect(h.records()[0]).toBe(accepted);
  });

  it("a re-auth retry superseded by a cancel voids the first attempt's record", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.tcl.fetchDevicesLive();
    h.seam.publishShadowUpdate = vi.fn(async () => {
      throw new Error("403 Forbidden");
    });
    const reauth = { held: false, release: () => undefined as void };
    let tokenWaits = 0;
    h.seam.ensureValidTokens = vi.fn(() => {
      tokenWaits += 1;
      if (tokenWaits !== 2) return Promise.resolve(); // the 2nd is the re-auth after the 403
      return new Promise<void>((resolve) => {
        reauth.held = true;
        reauth.release = resolve;
      });
    });

    const stepping = h.step();
    await until(() => reauth.held);
    expect(h.records()).toEqual([{ id: expect.any(Number), publishedAt: T0 + 6_000, voided: false, reportAt: null }]); // recorded at its publish boundary
    h.tcl.cancelOffWhenOnline(GUEST, REASON);
    reauth.release();
    await stepping;

    expect(h.records()).toEqual([{ id: expect.any(Number), publishedAt: T0 + 6_000, voided: true, reportAt: null }]);
  });
});

describe("R1: a rollback voids only its own publish record (per-publish, append-only records)", () => {
  const isOurs = (h: Awaited<ReturnType<typeof setup>>) =>
    (h.collector as unknown as { isOffWhenOnlineOff: (deviceId: string) => boolean }).isOffWhenOnlineOff(GUEST);
  /** The TCL session, as setup() seeds it (a 403 drops it; a re-auth restores it). */
  const restoreSession = (h: Awaited<ReturnType<typeof setup>>) => {
    h.seam.tokenData = { saasToken: "t", cognitoToken: "c", cognitoId: "i", mqttEndpoint: "m" };
    h.seam.awsCreds = { accessKeyId: "k", secretKey: "s", sessionToken: "x", expiration: T0 + 3_600_000, region: "eu-central-1" };
  };

  it("a publish hung past its lease and then rejected voids only its own record: the takeover's accepted record survives, and the OFF it caused is ours", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.tcl.fetchDevicesLive(); // a fresh snapshot: the OFF's publish is the first thing to wait
    const hung = { held: false, reject: (_err: Error) => undefined as void };
    let offPublishes = 0;
    h.seam.publishShadowUpdate = vi.fn((_deviceId: string, desired: Record<string, unknown>) => {
      if (desired.powerSwitch === 0 && ++offPublishes === 1) {
        return new Promise<void>((_resolve, reject) => {
          hung.held = true;
          hung.reject = reject;
        });
      }
      h.published.push(desired);
      return Promise.resolve();
    });

    const old = h.step();
    await until(() => hung.held);
    h.at(6_000 + OFF_WHEN_ONLINE_LEASE_MS + 1_000);
    await h.step(); // a takeover: its OFF is accepted
    hung.reject(new Error("socket hang up")); // the old publish fails at last
    await old;

    h.report(0, 128); // the takeover's OFF landed
    h.at(129_000);
    await h.tcl.fetchDevicesLive(); // the snapshot an observing rule reads
    expect(isOurs(h)).toBe(true);
    expect(h.records()).toEqual([{ id: expect.any(Number), publishedAt: T0 + 127_000, voided: false, reportAt: T0 + 128_000 }]);
  });

  it("a re-auth retry superseded by a cancel voids only its own record: the earlier accepted send's record stays, and the OFF it caused is still ours", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.step(); // send 1: accepted
    h.at(21_000);
    await h.tcl.fetchDevicesLive(); // still ON: a fresh snapshot for the resend
    h.seam.publishShadowUpdate = vi.fn(async () => {
      throw new Error("403 Forbidden");
    });
    const reauth = { held: false, release: () => undefined as void };
    h.seam.ensureValidTokens = vi.fn(() => {
      if (h.seam.tokenData != null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        reauth.held = true;
        reauth.release = resolve;
      });
    });

    const resending = h.step(); // send 2: refused (403), then its re-auth hangs
    await until(() => reauth.held);
    expect(h.records()).toHaveLength(2); // send 2 recorded at its publish boundary
    h.tcl.cancelOffWhenOnline(GUEST, REASON);
    restoreSession(h);
    reauth.release();
    await resending; // superseded by the cancel

    h.report(0, 22); // send 1's OFF lands
    h.at(23_000);
    await h.tcl.fetchDevicesLive();
    expect(isOurs(h)).toBe(true);
    expect(h.records()).toEqual([{ id: expect.any(Number), publishedAt: T0 + 6_000, voided: false, reportAt: T0 + 22_000 }]);
  });

  it("a send accepted on its re-auth retry after a 403: only the accepted publish keeps a live record, so an OFF reported before it is not ours", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.tcl.fetchDevicesLive();
    let offPublishes = 0;
    h.seam.publishShadowUpdate = vi.fn(async (_deviceId: string, desired: Record<string, unknown>) => {
      if (desired.powerSwitch === 0 && ++offPublishes === 1) throw new Error("403 Forbidden");
      h.published.push(desired);
    });
    h.seam.ensureValidTokens = vi.fn(async () => {
      if (h.seam.tokenData != null) return;
      h.at(7_000); // the re-auth takes a second
      restoreSession(h);
    });

    await h.step();
    expect(h.offs()).toBe(1);

    h.report(0, 6); // a hand on the remote while the refused publish re-authenticated
    h.at(8_000);
    await h.tcl.fetchDevicesLive();
    expect(isOurs(h)).toBe(false);
    // The refused publish's record was voided (and pruned); the accepted one stands, unmatched.
    expect(h.records()).toEqual([{ id: expect.any(Number), publishedAt: T0 + 7_000, voided: false, reportAt: null }]);
  });
});

describe("S4: a terminal OFF survives a restart", () => {
  it("a persisted arm, a qualifying OFF a fetch saw, then a restart before any step: the unit reporting ON again gets no OFF", async () => {
    const first = await setup({ armFile: { [GUEST]: { armedAt: T0 - 5_000 } } });
    first.report(0, 5); // the unit came back OFF, seen by a dashboard poll
    first.at(6_000);
    await first.tcl.fetchDevicesLive();
    await settle();

    const restarted = await setup(); // a new Collector and TclCloud on the retained arm file
    await restarted.loaded();
    restarted.report(1, 20); // later switched on by hand
    restarted.at(21_000);
    await restarted.step();

    expect(restarted.published).toEqual([]);
    expect(restarted.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
  });
});

describe("L4: a real source transition is a power epoch", () => {
  it("arm, a brief post-arm report, grid to generator, later grid return: no attempts against the pre-transition report; the OFF fires on post-transition evidence", async () => {
    const h = await setup();
    h.arm(); // offline ON on generator, armed at T0
    h.report(1, 5); // a brief post-arm report (the grid blinked back)
    h.at(6_000);
    await h.step();
    expect(h.offs()).toBe(1); // that report was real and current: one OFF

    h.at(10_000);
    h.collector.notePowerEvent("source grid → gen"); // the Guest line is gone again
    h.setTclOnline(false);
    expect(h.entry()).toMatchObject({ epochAt: T0 + 10_000, attempts: 0, lastSentAt: 0 });

    // The 5 s report stays "fresh" for SHADOW_STALE_MS after the line died.
    for (let t = 25_000; t <= 9 * 60_000; t += 15_000) {
      h.at(t);
      await h.step();
    }
    expect(h.offs()).toBe(1);
    expect(h.entry()).toMatchObject({ attempts: 0 });
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);

    h.at(20 * 60_000);
    h.collector.notePowerEvent("source gen → grid"); // the grid returns
    h.setTclOnline(true);
    h.report(1, 20 * 60 + 40); // the unit's first report on the new grid
    h.at(20 * 60_000 + 41_000);
    await h.step();

    expect(h.offs()).toBe(2);
    expect(h.entry()).toMatchObject({ epochAt: T0 + 20 * 60_000, attempts: 1 });
  });

  it("a meter-only gap and a server boot (source none) are not epochs: the attempts keep counting", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.step();
    expect(h.entry()?.attempts).toBe(1);

    h.at(8_000);
    h.collector.notePowerEvent("ESP gap 25s");
    h.collector.notePowerEvent("source none → grid");

    expect(h.entry()).toMatchObject({ epochAt: 0, attempts: 1 });
  });
});

describe("L5: the operation claim has a token and a lease", () => {
  it("a send held past the lease: a new step takes over and sends; the old one, released, publishes nothing and changes nothing", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.tcl.fetchDevicesLive(); // a fresh snapshot: the only token wait left is the OFF's own
    const hold = h.holdNextTokenWait();

    const first = h.step();
    await until(() => hold.held);
    h.at(6_000 + OFF_WHEN_ONLINE_LEASE_MS + 1_000); // runStep abandoned it long ago; its lease ran out
    await h.step(); // a new tick takes the device over and sends

    expect(h.offs()).toBe(1);
    const afterTakeover = { ...h.entry()! };
    expect(afterTakeover).toMatchObject({ attempts: 1, lastSentAt: T0 + 6_000 + OFF_WHEN_ONLINE_LEASE_MS + 1_000 });

    hold.release();
    await first;
    expect(h.offs()).toBe(1); // exactly the new send
    expect(h.entry()).toEqual(afterTakeover); // the old completion changed nothing
    expect(logSpy.warn).toHaveBeenCalledWith(expect.stringContaining("lease"));
  });

  it("within the lease a second step does nothing (one operation per device)", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.tcl.fetchDevicesLive();
    const hold = h.holdNextTokenWait();

    const first = h.step();
    await until(() => hold.held);
    h.at(6_000 + RESEND_MS + 5_000); // the next ticks, well inside the lease
    await h.step();
    expect(h.published).toEqual([]);

    hold.release();
    await first;
    expect(h.offs()).toBe(1);
    expect(h.entry()?.attempts).toBe(1);
  });
});

describe("the step: newer user intent wins at every await", () => {
  it("cancelled during the snapshot fetch: nothing sent", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    const hold = h.holdNextTokenWait(); // the live snapshot fetch's token wait

    const stepping = h.step();
    await until(() => hold.held);
    void h.tcl.cancelOffWhenOnline(GUEST, REASON);
    hold.release();
    await stepping;

    expect(h.published).toEqual([]);
  });

  it("a dashboard ON (the control route's entry cancel, then its send) during the OFF's token wait wins at the publish boundary", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.at(6_000);
    await h.tcl.fetchDevicesLive(); // a fresh snapshot, so the only token wait left is the OFF's own
    const hold = h.holdNextTokenWait();

    const stepping = h.step();
    await until(() => hold.held);
    void h.tcl.cancelOffWhenOnline(GUEST, REASON);
    expect(await h.tcl.sendControlVerified(GUEST, "set_power", 1)).toBe("sent");
    hold.release();
    await stepping;

    expect(h.published).toEqual([{ powerSwitch: 1 }]);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
  });
});

describe("L8: TCL re-auth when no automation rule is left to drive it", () => {
  it("zero rules, cloud not ready, an arm pending: the step attempts the throttled re-auth and resumes once ready", async () => {
    const h = await setup();
    h.arm();
    h.report(1, 5);
    h.seam.tokenData = null; // the session is gone: isReady() is false
    let attempts = 0;
    const init = vi.spyOn(h.tcl, "init").mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("TCL login HTTP 502");
      h.seam.tokenData = { saasToken: "t", cognitoToken: "c", cognitoId: "i", mqttEndpoint: "m" };
    });

    h.at(6_000);
    await h.step();
    expect(init).toHaveBeenCalledTimes(1);
    h.at(30_000);
    await h.step(); // throttled: one attempt a minute (tclRetryAt)
    expect(init).toHaveBeenCalledTimes(1);
    expect(h.published).toEqual([]);

    h.at(66_000);
    await h.step();
    expect(init).toHaveBeenCalledTimes(2);
    await settle();
    expect(h.tcl.isReady()).toBe(true);

    h.at(67_000);
    await h.step();
    expect(h.offs()).toBe(1);
    expect(init).toHaveBeenCalledTimes(2);
  });
});

describe("the step after a restart", () => {
  it("a persisted arm from the lock rounds loads with those fields ignored and fires a plain OFF from attempt 0", async () => {
    const h = await setup({
      armFile: { [GUEST]: { armedAt: T0 - 5_000, lockRecorded: true, offConfirmedAt: null, attempts: 3 } },
    });
    h.report(1, 5);
    h.at(6_000);

    await h.step();

    expect(h.events).toEqual(["publish-off"]);
    expect(h.entry()?.attempts).toBe(1);
    expect(h.lockSql).toEqual([]);
  });

  it("a persisted power epoch still gates: a report older than it fires nothing", async () => {
    const h = await setup({ armFile: { [GUEST]: { armedAt: T0 - 600_000, epochAt: T0 + 30_000 } } });
    h.report(1, 5); // after the arm, but before the last source transition
    h.at(40_000);
    await h.step();
    expect(h.published).toEqual([]);

    h.report(1, 45);
    h.at(51_000); // the 40 s snapshot is too old now: refreshed
    await h.step();
    expect(h.events).toEqual(["publish-off"]);
  });
});
