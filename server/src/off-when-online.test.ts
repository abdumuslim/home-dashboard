// "Turn off once back online" for the grid-only Guest AC (owner request
// 2026-10-09): the TclCloud side. TclCloud stores the arm, reports it on each
// device snapshot, lets a device fetch end the arm on an OFF the unit reported
// (arm state only: nothing sent; the OFF is handed to the collector's step),
// holds the per-device operation claim (token and lease), marks power epochs,
// sends the OFF when the collector's step asks (its publish guard re-checks the
// arm, the claim and the gated power epoch), and keeps the last-state restore
// out of its way. Since 2026-10-10 the deferred OFF is a
// plain server OFF (owner decision: the manual-off lock was dropped), so nothing
// here touches the lock; off-when-online-step.test.ts pins that across the
// whole path.
//
// These tests drive the REAL device fetch (`fetchDevices`: user_groups/get plus
// a shadow GET through a stubbed global fetch), so the AcDevice flag and the
// ordering against `maybeRestorePowerCycleState` / `saveStateProps` are covered.
// Only the Date is faked; real setImmediate keeps the async plumbing flowing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fs/promises is mocked so persistence is asserted without touching /app/data.
// readFile serves `files` (ENOENT otherwise); writeFile stores into `files`;
// rename moves an entry and records the completed write in `writes` (the arm
// file is written to a temp file, then renamed over the target). With
// `deferred` set, every read and write waits until the test settles (or fails)
// it (persistence ordering tests). `failReads`/`failWrites`/`failRenames`
// inject disk errors.
const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writes: [] as Array<{ path: string; data: string }>,
  renames: [] as Array<{ from: string; to: string }>,
  deferred: false,
  pendingReads: [] as Array<{ path: string; settle: () => void }>,
  pendingWrites: [] as Array<{ path: string; data: string; settle: () => void; fail: (err: Error) => void }>,
  failReads: null as Error | null,
  failWrites: null as Error | null,
  failRenames: null as Error | null,
}));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const read = async (path: string): Promise<string> => {
    if (fsMock.failReads) throw fsMock.failReads;
    const content = fsMock.files.get(path);
    if (content == null) throw enoent(path);
    return content;
  };
  return {
    ...actual,
    readFile: vi.fn((path: string) => {
      const p = String(path);
      if (!fsMock.deferred) return read(p);
      return new Promise<string>((resolve, reject) => {
        fsMock.pendingReads.push({ path: p, settle: () => { read(p).then(resolve, reject); } });
      });
    }),
    writeFile: vi.fn((path: string, data: string) => {
      const entry = { path: String(path), data: String(data) };
      if (fsMock.failWrites) return Promise.reject(fsMock.failWrites);
      if (!fsMock.deferred) {
        fsMock.files.set(entry.path, entry.data);
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        fsMock.pendingWrites.push({
          ...entry,
          settle: () => {
            fsMock.files.set(entry.path, entry.data);
            resolve();
          },
          fail: reject,
        });
      });
    }),
    rename: vi.fn(async (from: string, to: string) => {
      if (fsMock.failRenames) throw fsMock.failRenames;
      const data = fsMock.files.get(String(from));
      if (data == null) throw enoent(String(from));
      fsMock.files.delete(String(from));
      fsMock.files.set(String(to), data);
      fsMock.renames.push({ from: String(from), to: String(to) });
      fsMock.writes.push({ path: String(to), data });
    }),
  };
});

// One shared logger so the loud cancel, refusal and corruption lines can be asserted.
const logSpy = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./logger.js", () => ({ childLogger: () => logSpy }));

import { OFF_WHEN_ONLINE_DURABLE_MAX_WRITES, OFF_WHEN_ONLINE_LEASE_MS, TclCloud, type AcDevice, type OffWhenOnlineArm } from "./tcl-cloud.js";

const GUEST = "DlXqDBFAAAE";
/** A Smart AC Leveling room (real policy, leveling-eligible). */
const ABDU = "CA5IMhFAAAE";
const OFF_FILE = "/app/data/ac-off-when-online.json";
/** A whole second, as AWS shadow metadata stamps are. */
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const REASON = "cancelled by direct user power command";

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
  pendingPowerCycleRestores: Map<string, unknown>;
  pendingOffWhenOnline: Map<string, OffWhenOnlineArm>;
  fetchDevices: () => Promise<AcDevice[]>;
}

type ShadowDoc = Record<string, unknown>;

/** A Guest (TAC-24CHSA) shadow whose every field was last reported at `reportedAtMs`. */
function shadowDoc(power: 0 | 1, reportedAtMs: number): ShadowDoc {
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

async function harness(tcl: TclCloud = new TclCloud("user", "pass")) {
  const seam = tcl as unknown as Seam;
  const published: Array<Record<string, unknown>> = [];
  let doc: ShadowDoc = shadowDoc(1, T0 - 3_600_000); // the stale shadow of a unit that dropped offline ON

  seam.tokenData = { saasToken: "t", cognitoToken: "c", cognitoId: "i", mqttEndpoint: "m" };
  seam.authData = { token: "a", refreshToken: "r", username: "u", countryAbbr: "IQ" };
  seam.awsCreds = { accessKeyId: "k", secretKey: "s", sessionToken: "x", expiration: T0 + 3_600_000, region: "eu-central-1" };
  seam.signAwsRequest = () => ({});
  seam.ensureValidTokens = vi.fn(async () => undefined);
  seam.publishShadowUpdate = vi.fn(async (_deviceId: string, desired: Record<string, unknown>) => {
    published.push(desired);
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("user_groups/get")) {
      return new Response(JSON.stringify({
        code: 0,
        data: [{ devices: [{ deviceId: GUEST, nickName: "guest", isOnline: "1" }] }],
      }));
    }
    return new Response(JSON.stringify(doc));
  }));

  // Seed the device cache the way fetchDevicesLive would, so executeAcAction
  // can sanitize the OFF.
  seam.cachedDevices = await seam.fetchDevices();
  published.length = 0;

  return {
    tcl,
    seam,
    published,
    /** The unit's newest report, `secFromT0` seconds after the arm time. */
    report(power: 0 | 1, secFromT0: number): void {
      doc = shadowDoc(power, T0 + secFromT0 * 1000);
    },
    at(msFromT0: number): void {
      vi.setSystemTime(T0 + msFromT0);
    },
    async poll(): Promise<AcDevice> {
      const [dev] = await seam.fetchDevices();
      return dev;
    },
    arm(): OffWhenOnlineArm {
      void tcl.setOffWhenOnline(GUEST, true);
      const arm = seam.pendingOffWhenOnline.get(GUEST);
      if (!arm) throw new Error("not armed");
      return arm;
    },
    entry(): OffWhenOnlineArm | undefined {
      return seam.pendingOffWhenOnline.get(GUEST);
    },
  };
}

/** Park the next token wait (the one inside a send, before its publish) until `release()`. */
function holdNextTokenWait(seam: Seam) {
  const hold = { held: false, release: () => undefined as void };
  let used = false;
  seam.ensureValidTokens = vi.fn(() => {
    if (used) return Promise.resolve();
    used = true;
    return new Promise<void>((resolve) => {
      hold.held = true;
      hold.release = resolve;
    });
  });
  return hold;
}

/** Let the real async plumbing (response bodies, un-awaited file reads) run. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  if (!condition()) throw new Error("condition not reached");
}

/** A few macrotask turns: lets chained (un-awaited) file writes run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Deferred-fs mode: settle every pending read and write (newest write first) until none is left. */
async function drainDeferredFs(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    await settle();
    const reads = fsMock.pendingReads.splice(0);
    const writes = fsMock.pendingWrites.splice(0).reverse();
    if (reads.length === 0 && writes.length === 0) return;
    for (const read of reads) read.settle();
    for (const write of writes) write.settle();
  }
  throw new Error("deferred fs never drained");
}

/** Every COMPLETED arm-file write (renamed over the target), oldest first. */
function offFileWrites(): Array<Record<string, unknown>> {
  return fsMock.writes
    .filter((write) => write.path === OFF_FILE)
    .map((write) => JSON.parse(write.data) as Record<string, unknown>);
}

beforeEach(() => {
  fsMock.files.clear();
  fsMock.writes.length = 0;
  fsMock.renames.length = 0;
  fsMock.deferred = false;
  fsMock.pendingReads.length = 0;
  fsMock.pendingWrites.length = 0;
  fsMock.failReads = null;
  fsMock.failWrites = null;
  fsMock.failRenames = null;
  logSpy.info.mockClear();
  logSpy.warn.mockClear();
  logSpy.error.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("off when back online: a device fetch sends nothing; an OFF it sees ends the arm", () => {
  it("a fresh ON report changes nothing; a fresh OFF report ends the arm at once: loud, persisted, nothing published, handed to the collector's step", async () => {
    const h = await harness();
    h.arm();
    await settle();
    const writesAfterArm = offFileWrites().length;

    h.report(1, 5);
    h.at(6_000);
    expect((await h.poll()).offWhenOnline).toBe(true);
    expect(h.entry()).toMatchObject({ attempts: 0 });
    await settle();
    expect(offFileWrites()).toHaveLength(writesAfterArm);

    h.report(0, 8);
    h.at(9_000);
    expect((await h.poll()).offWhenOnline).toBe(false); // that very snapshot already shows it done
    await settle();

    expect(h.published).toEqual([]);
    expect(h.entry()).toBeUndefined();
    expect(offFileWrites().at(-1)).toEqual({});
    expect(logSpy.info).toHaveBeenCalledWith(expect.stringContaining(`Off-when-back-online for ${GUEST} done`));
    expect(h.tcl.takeOffWhenOnlineSeenOffs()).toEqual([[GUEST, T0 + 8_000]]);
    expect(h.tcl.takeOffWhenOnlineSeenOffs()).toEqual([]); // taken once
  });

  it("L3: an OFF ends the arm once it is newer than the arm and the last power epoch, one reported between two of our sends included", async () => {
    const h = await harness();
    const arm = h.arm(); // armedAt = T0

    h.report(0, 0); // the arm's own second: not newer
    h.at(1_000);
    await h.poll();
    expect(h.tcl.isOffWhenOnlineCurrent(arm)).toBe(true);

    h.tcl.noteOffWhenOnlinePowerEpoch(T0 + 10_000);
    h.report(0, 10); // the epoch's own second: not newer
    h.at(11_000);
    await h.poll();
    expect(h.tcl.isOffWhenOnlineCurrent(arm)).toBe(true);
    expect(h.tcl.takeOffWhenOnlineSeenOffs()).toEqual([]);

    h.report(1, 20); // back ON after the epoch: two sends, 15 s apart
    h.at(21_000);
    const token = h.tcl.claimOffWhenOnline(GUEST)!;
    expect(await h.tcl.sendOffWhenOnline(arm, token)).toBe("sent");
    h.at(36_000);
    expect(await h.tcl.sendOffWhenOnline(arm, token)).toBe("sent");

    h.report(0, 30); // the first send landed late: reported before the second one started
    h.at(37_000);
    await h.poll();
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(h.tcl.takeOffWhenOnlineSeenOffs()).toEqual([[GUEST, T0 + 30_000]]);
    expect(h.published).toEqual([{ powerSwitch: 0 }, { powerSwitch: 0 }]);
  });

  it("the AcDevice flag is the arm at snapshot time: armed while the arm stands, gone once disarmed", async () => {
    const h = await harness();
    expect((await h.poll()).offWhenOnline).toBe(false);

    h.arm();
    expect((await h.poll()).offWhenOnline).toBe(true);

    void h.tcl.setOffWhenOnline(GUEST, false);
    expect((await h.poll()).offWhenOnline).toBe(false);
  });
});

describe("off when back online: the last-state restore stays out of its way", () => {
  it("arming cancels a pending last-state restore, loudly; the unit's fresh ON report then publishes no restore", async () => {
    const h = await harness();
    h.seam.lastState = { [GUEST]: { workMode: 1, targetTemperature: 22, windSpeed7Gear: 5 } };
    h.at(-60_000);
    expect(h.tcl.preparePowerCycleRestore(GUEST)).toBe(true);
    h.at(0);

    h.arm();
    expect(h.seam.pendingPowerCycleRestores.has(GUEST)).toBe(false);
    expect(logSpy.info).toHaveBeenCalledWith(
      expect.stringContaining(`Pending last-state restore for ${GUEST} cancelled by off-when-back-online`),
    );

    h.report(1, 5); // shadow target 24 differs from the frozen 22, so a restore WOULD publish
    h.at(6_000);
    await h.poll();
    expect(h.published).toEqual([]);
  });

  it("control: without an arm the same fresh ON report does publish the restore", async () => {
    const h = await harness();
    h.seam.lastState = { [GUEST]: { workMode: 1, targetTemperature: 22, windSpeed7Gear: 5 } };
    h.at(-60_000);
    expect(h.tcl.preparePowerCycleRestore(GUEST)).toBe(true);

    h.report(1, 5);
    h.at(6_000);
    await h.poll();

    expect(h.published).toEqual([{ workMode: 1, targetTemperature: 22, windSpeed7Gear: 5 }]);
  });

  it("a power event while armed: the restore is refused, loudly; once the arm is gone it arms again", async () => {
    const h = await harness();
    h.seam.lastState = { [GUEST]: { workMode: 1, targetTemperature: 22, windSpeed7Gear: 5 } };
    h.arm();

    expect(h.tcl.preparePowerCycleRestore(GUEST)).toBe(false);
    expect(h.seam.pendingPowerCycleRestores.has(GUEST)).toBe(false);
    expect(logSpy.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Refusing last-state restore for ${GUEST}: off-when-back-online is armed`),
    );

    void h.tcl.setOffWhenOnline(GUEST, false);
    expect(h.tcl.preparePowerCycleRestore(GUEST)).toBe(true);
  });

  it("state saving pauses while armed (the reboot-default ON state never replaces the frozen settings) and resumes once the arm resolves", async () => {
    const h = await harness();
    h.seam.lastState = { [GUEST]: { workMode: 1, targetTemperature: 22, windSpeed7Gear: 5 } };
    const arm = h.arm();

    h.report(1, 5); // back ON at its reboot defaults: 24 C, fan 3
    h.at(6_000);
    await h.poll();
    expect(h.seam.lastState[GUEST]).toEqual({ workMode: 1, targetTemperature: 22, windSpeed7Gear: 5 });

    const token = h.tcl.claimOffWhenOnline(GUEST)!;
    h.tcl.finishOffWhenOnline(arm, token, "done: unit reported OFF");
    h.report(1, 60); // later switched on by hand at 24 C / fan 3
    h.at(61_000);
    await h.poll();
    expect(h.seam.lastState[GUEST]).toMatchObject({ targetTemperature: 24, windSpeed7Gear: 3 });
  });
});

describe("off when back online: the OFF send, the operation claim and the arm helpers", () => {
  it("sendOffWhenOnline publishes powerSwitch 0, runs onPublish at the publish boundary, and counts the completed send", async () => {
    const h = await harness();
    const arm = h.arm();
    h.at(6_000);
    const token = h.tcl.claimOffWhenOnline(GUEST)!;
    const publishedWhenBooked: number[] = [];

    expect(await h.tcl.sendOffWhenOnline(arm, token, () => publishedWhenBooked.push(h.published.length))).toBe("sent");

    expect(h.published).toEqual([{ powerSwitch: 0 }]);
    expect(publishedWhenBooked).toEqual([0]); // once, right before the publish started
    expect(arm).toMatchObject({ attempts: 1, lastSentAt: T0 + 6_000 });
  });

  it("a cancel while the send waits: nothing published, onPublish never runs, nothing counted", async () => {
    const h = await harness();
    const arm = h.arm();
    const token = h.tcl.claimOffWhenOnline(GUEST)!;
    const hold = holdNextTokenWait(h.seam);
    const onPublish = vi.fn();

    const sending = h.tcl.sendOffWhenOnline(arm, token, onPublish);
    await until(() => hold.held);
    void h.tcl.cancelOffWhenOnline(GUEST, REASON);
    hold.release();

    expect(await sending).toBe("superseded");
    expect(h.published).toEqual([]);
    expect(onPublish).not.toHaveBeenCalled();
    expect(arm).toMatchObject({ attempts: 0, lastSentAt: 0 });
  });

  it("S1: an OFF held before publication; a fetch then sees the unit OFF and then ON again: that OFF ended the arm, so the release publishes nothing", async () => {
    const h = await harness();
    const arm = h.arm();
    h.report(1, 5);
    h.at(6_000);
    const token = h.tcl.claimOffWhenOnline(GUEST)!;
    const hold = holdNextTokenWait(h.seam);
    const onPublish = vi.fn();

    const sending = h.tcl.sendOffWhenOnline(arm, token, onPublish);
    await until(() => hold.held);
    h.report(0, 8); // a hand on the remote, seen by a dashboard poll
    h.at(9_000);
    await h.poll();
    h.report(1, 12); // and switched back on: the waiting OFF must not land over it
    h.at(13_000);
    await h.poll();
    hold.release();

    expect(await sending).toBe("superseded");
    expect(h.published).toEqual([]);
    expect(onPublish).not.toHaveBeenCalled();
    expect(arm).toMatchObject({ attempts: 0, lastSentAt: 0 });
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
  });

  it("S1: an OFF held before publication; a power epoch arrives with no newer report: the release publishes nothing, and the arm waits for post-epoch evidence", async () => {
    const h = await harness();
    const arm = h.arm();
    h.report(1, 5);
    h.at(6_000);
    const token = h.tcl.claimOffWhenOnline(GUEST)!;
    const hold = holdNextTokenWait(h.seam);
    const onPublish = vi.fn();

    const sending = h.tcl.sendOffWhenOnline(arm, token, onPublish);
    await until(() => hold.held);
    h.at(8_000);
    h.tcl.noteOffWhenOnlinePowerEpoch(T0 + 8_000); // the line dropped again: the 5 s report gated a dead epoch
    hold.release();

    expect(await sending).toBe("superseded");
    expect(h.published).toEqual([]);
    expect(onPublish).not.toHaveBeenCalled();
    expect(arm).toMatchObject({ epochAt: T0 + 8_000, attempts: 0, lastSentAt: 0 });
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);
  });

  it("S1: the guard holds the epoch the caller's gate read: a send gated before the latest epoch publishes nothing", async () => {
    const h = await harness();
    const arm = h.arm();
    const gatedEpochAt = arm.epochAt;
    h.tcl.noteOffWhenOnlinePowerEpoch(T0 + 5_000); // lands between the caller's gate and its send
    const token = h.tcl.claimOffWhenOnline(GUEST)!;
    const onPublish = vi.fn();

    expect(await h.tcl.sendOffWhenOnline(arm, token, onPublish, gatedEpochAt)).toBe("superseded");
    expect(h.published).toEqual([]);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("a failed publish counts too (a cloud outage cannot resend forever) and the error reaches the caller", async () => {
    const h = await harness();
    const arm = h.arm();
    const token = h.tcl.claimOffWhenOnline(GUEST)!;
    h.seam.publishShadowUpdate = vi.fn(async () => {
      throw new Error("cloud down");
    });

    await expect(h.tcl.sendOffWhenOnline(arm, token)).rejects.toThrow("cloud down");
    expect(arm.attempts).toBe(1);
  });

  it("L5: one operation per device, with a lease: a second claim fails until the first is released or its lease runs out", () => {
    const tcl = new TclCloud("user", "pass");

    const first = tcl.claimOffWhenOnline(GUEST);
    expect(first).not.toBeNull();
    expect(tcl.claimOffWhenOnline(GUEST)).toBeNull();
    expect(tcl.claimOffWhenOnline(ABDU)).not.toBeNull();
    tcl.releaseOffWhenOnline(GUEST, (first as number) + 1000); // another operation's token frees nothing
    expect(tcl.claimOffWhenOnline(GUEST)).toBeNull();
    tcl.releaseOffWhenOnline(GUEST, first as number);
    const second = tcl.claimOffWhenOnline(GUEST);
    expect(second).not.toBeNull();

    vi.setSystemTime(T0 + OFF_WHEN_ONLINE_LEASE_MS - 1);
    expect(tcl.claimOffWhenOnline(GUEST)).toBeNull();
    vi.setSystemTime(T0 + OFF_WHEN_ONLINE_LEASE_MS);
    const third = tcl.claimOffWhenOnline(GUEST); // the lease ran out: taken over, loudly
    expect(third).not.toBeNull();
    expect(logSpy.warn).toHaveBeenCalledWith(expect.stringContaining("lease"));
    tcl.releaseOffWhenOnline(GUEST, second as number); // the late release of the overtaken operation
    expect(tcl.claimOffWhenOnline(GUEST)).toBeNull();
  });

  it("L5: an operation whose claim was taken over publishes nothing, and its late completion changes nothing", async () => {
    const h = await harness();
    const arm = h.arm();
    h.at(6_000);
    const old = h.tcl.claimOffWhenOnline(GUEST)!;
    const hold = holdNextTokenWait(h.seam);
    const oldSend = h.tcl.sendOffWhenOnline(arm, old);
    await until(() => hold.held);

    h.at(6_000 + OFF_WHEN_ONLINE_LEASE_MS); // the old operation's lease ran out
    const fresh = h.tcl.claimOffWhenOnline(GUEST)!;
    expect(await h.tcl.sendOffWhenOnline(arm, fresh)).toBe("sent");
    expect(h.published).toEqual([{ powerSwitch: 0 }]);
    const afterFresh = { ...arm };

    hold.release();
    expect(await oldSend).toBe("superseded");
    expect(h.published).toEqual([{ powerSwitch: 0 }]);
    expect(arm).toEqual(afterFresh);
    expect(h.tcl.isOffWhenOnlineOperationCurrent(arm, old)).toBe(false);
    expect(h.tcl.isOffWhenOnlineOperationCurrent(arm, fresh)).toBe(true);
  });

  it("finishOffWhenOnline drops the arm loudly, and only for the operation holding the current arm's claim", async () => {
    const h = await harness();
    const older = h.arm();
    h.at(1_000);
    const newer = h.arm(); // re-armed: the older entry is stale now
    const token = h.tcl.claimOffWhenOnline(GUEST)!;

    expect(h.tcl.isOffWhenOnlineCurrent(older)).toBe(false);
    h.tcl.finishOffWhenOnline(older, token, "done: unit reported OFF");
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);
    h.tcl.finishOffWhenOnline(newer, token + 1000, "done: unit reported OFF"); // not the claim holder
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);

    h.tcl.finishOffWhenOnline(newer, token, "gave up: still ON after 4 OFF sends", "warn");
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(logSpy.warn).toHaveBeenCalledWith(`[tcl] Off-when-back-online for ${GUEST} gave up: still ON after 4 OFF sends`);
    await settle();
    expect(offFileWrites().at(-1)).toEqual({});
  });
});

describe("L4: a power epoch", () => {
  it("marks every arm, starts its attempts over, and is persisted", async () => {
    const h = await harness();
    const arm = h.arm();
    arm.attempts = 3;
    arm.lastSentAt = T0 + 40_000;
    h.at(60_000);

    h.tcl.noteOffWhenOnlinePowerEpoch(T0 + 60_000);

    expect(arm).toMatchObject({ epochAt: T0 + 60_000, attempts: 0, lastSentAt: 0 });
    await settle();
    expect(offFileWrites().at(-1)).toEqual({ [GUEST]: { armedAt: T0, epochAt: T0 + 60_000 } });
  });

  it("a send already publishing when the epoch lands is not counted in the new one", async () => {
    const h = await harness();
    const arm = h.arm();
    const token = h.tcl.claimOffWhenOnline(GUEST)!;
    let publishing = false;
    let finishPublish: () => void = () => undefined;
    h.seam.publishShadowUpdate = vi.fn((_deviceId: string, desired: Record<string, unknown>) => {
      h.published.push(desired);
      publishing = true;
      return new Promise<void>((resolve) => { finishPublish = resolve; });
    });
    const sending = h.tcl.sendOffWhenOnline(arm, token);
    await until(() => publishing);

    h.at(5_000);
    h.tcl.noteOffWhenOnlinePowerEpoch(T0 + 5_000);
    finishPublish();

    expect(await sending).toBe("sent");
    expect(h.published).toEqual([{ powerSwitch: 0 }]);
    expect(arm).toMatchObject({ epochAt: T0 + 5_000, attempts: 0, lastSentAt: 0 });
  });
});

describe("L7: newer user intent, and only newer intent, supersedes", () => {
  it("the control route's entry cancel drops the arm loudly; the stale arm's OFF then publishes nothing", async () => {
    const h = await harness();
    const arm = h.arm();
    const token = h.tcl.claimOffWhenOnline(GUEST)!;

    h.tcl.cancelOffWhenOnline(GUEST, REASON);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(logSpy.info).toHaveBeenCalledWith(expect.stringContaining(`disarmed: ${REASON}`));

    expect(await h.tcl.sendOffWhenOnline(arm, token)).toBe("superseded");
    expect(h.published).toEqual([]);
    expect(arm.attempts).toBe(0);
  });

  it("sendControlVerified no longer disarms by itself: an arm newer than the control request survives its send", async () => {
    const h = await harness();
    h.seam.controlVerifyDelay = () => new Promise<void>(() => undefined); // park the user's verifier
    h.seam.lastState = {};
    h.arm(); // accepted while an older control request was still validating

    expect(await h.tcl.sendControlVerified(GUEST, "set_power", 1)).toBe("sent");

    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);
    expect(logSpy.info).not.toHaveBeenCalledWith(expect.stringContaining("disarmed"));
  });

  it("executeAcActionVerified no longer disarms by itself: the preset route cancels at its entry instead", async () => {
    const h = await harness();
    h.seam.lastState = {};
    h.arm();

    // A preset with no profile fields left after sanitizing goes straight to
    // executeAcAction; the point is only that the arm stays.
    await h.tcl.executeAcActionVerified(GUEST, { power: 1 });

    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);
  });

  it("arming supersedes an older dashboard ON still waiting to publish: it is never sent (superseded by the user)", async () => {
    const h = await harness();
    h.seam.controlVerifyDelay = () => new Promise<void>(() => undefined);
    h.seam.lastState = {};
    const hold = holdNextTokenWait(h.seam);

    const sending = h.tcl.sendControlVerified(GUEST, "set_power", 1);
    await until(() => hold.held);
    h.arm();
    hold.release();

    expect(await sending).toBe("superseded_by_user");
    expect(h.published).toEqual([]);
    expect(h.tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);
  });

  it("arming stops an older ON verifier: no ON is re-sent over the newer arm", async () => {
    const h = await harness();
    h.seam.lastState = {};
    h.report(0, -3_600); // the unit's last word: OFF, an hour ago, so the verifier would re-send its ON
    const delays: Array<() => void> = [];
    h.seam.controlVerifyDelay = () => new Promise<void>((resolve) => delays.push(resolve));

    expect(await h.tcl.sendControlVerified(GUEST, "set_power", 1)).toBe("sent");
    expect(h.published).toEqual([{ powerSwitch: 1 }]);
    await until(() => delays.length === 1);

    h.arm();
    delays[0]();
    await settle();

    expect(h.published).toEqual([{ powerSwitch: 1 }]);
    expect(logSpy.info).toHaveBeenCalledWith(expect.stringContaining("superseded by a newer command"));
  });

  it("an OFF that went stale during executeAcAction's cache fill never claims set_power over the user's newer ON", async () => {
    const h = await harness();
    h.seam.controlVerifyDelay = () => new Promise<void>(() => undefined);
    const arm = h.arm();
    const token = h.tcl.claimOffWhenOnline(GUEST)!;
    const seam = h.seam as unknown as {
      ensureDeviceCachePopulated: () => Promise<void>;
      controlGenerations: Map<string, number>;
      controlClaimedBy: Map<string, string>;
    };
    let releaseFill: () => void = () => undefined;
    let parked = false;
    let filling = false;
    seam.ensureDeviceCachePopulated = vi.fn(() => {
      if (parked) return Promise.resolve();
      parked = true;
      return new Promise<void>((resolve) => {
        filling = true;
        releaseFill = resolve;
      });
    });

    const sending = h.tcl.sendOffWhenOnline(arm, token);
    await until(() => filling);

    // What the control route does for a dashboard ON: cancel at its entry, then send.
    h.seam.lastState = {};
    void h.tcl.cancelOffWhenOnline(GUEST, REASON);
    expect(await h.tcl.sendControlVerified(GUEST, "set_power", 1)).toBe("sent");
    const key = `${GUEST}:set_power`;
    const userGeneration = seam.controlGenerations.get(key);
    releaseFill();

    expect(await sending).toBe("superseded");
    expect(seam.controlGenerations.get(key)).toBe(userGeneration); // the user's ON still owns the field
    expect(seam.controlClaimedBy.get(key)).toBe("user");
    expect(h.published).toEqual([{ powerSwitch: 1 }]);
  });
});

describe("off when back online: persistence (L6: durable and atomic)", () => {
  it("writes each change to a temp file renamed over the arm file, after the startup read", async () => {
    const tcl = new TclCloud("user", "pass");

    await tcl.setOffWhenOnline(GUEST, true);
    expect(offFileWrites().at(-1)).toEqual({ [GUEST]: { armedAt: T0, epochAt: 0 } });
    expect(fsMock.renames.at(-1)).toEqual({ from: `${OFF_FILE}.tmp`, to: OFF_FILE });

    await tcl.setOffWhenOnline(GUEST, false);
    expect(offFileWrites().at(-1)).toEqual({});
  });

  it("setOffWhenOnline, and offWhenOnlineDurablyAbsent after a cancel, resolve only once the write holding the change completed", async () => {
    fsMock.deferred = true;
    const tcl = new TclCloud("user", "pass");

    let armed = false;
    const arming = tcl.setOffWhenOnline(GUEST, true).then(() => { armed = true; });
    await settle();
    expect(armed).toBe(false); // the startup read and the write are both still pending
    await drainDeferredFs();
    await arming;
    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({ [GUEST]: { armedAt: T0, epochAt: 0 } });

    let cancelled = false;
    tcl.cancelOffWhenOnline(GUEST, REASON);
    const cancelling = tcl.offWhenOnlineDurablyAbsent(GUEST).then(() => { cancelled = true; });
    await settle();
    expect(cancelled).toBe(false);
    await drainDeferredFs();
    await cancelling;
    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({});
  });

  it("a failed write rejects the acknowledgement and is logged loudly; the in-memory change stays and later writes still run", async () => {
    const tcl = new TclCloud("user", "pass");
    await settle();
    fsMock.failWrites = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });

    await expect(tcl.setOffWhenOnline(GUEST, true)).rejects.toThrow("ENOSPC");
    expect(tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);
    expect(logSpy.error).toHaveBeenCalledWith(expect.stringContaining("Could not save the off-when-back-online arms"));

    fsMock.failWrites = null;
    await tcl.setOffWhenOnline(GUEST, false);
    expect(offFileWrites().at(-1)).toEqual({});
  });

  it("a crash between the temp write and the rename leaves the previous arm file whole", async () => {
    fsMock.files.set(OFF_FILE, JSON.stringify({ [GUEST]: { armedAt: T0 - 5_000 } }));
    const tcl = new TclCloud("user", "pass");
    await until(() => tcl.isOffWhenOnlineArmed(GUEST));
    fsMock.failRenames = new Error("crashed before the rename");

    await expect(tcl.setOffWhenOnline(GUEST, false)).rejects.toThrow("crashed");

    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({ [GUEST]: { armedAt: T0 - 5_000 } });
    expect(JSON.parse(fsMock.files.get(`${OFF_FILE}.tmp`) ?? "null")).toEqual({});
  });

  it.each([["not JSON", "{oops"], ["JSON null", "null"], ["a JSON array", "[1, 2]"]])(
    "a file that is %s is CORRUPT: logged loudly and moved aside, never silently taken for none armed",
    async (_label, content) => {
      fsMock.files.set(OFF_FILE, content);
      const tcl = new TclCloud("user", "pass");
      await settle();

      const aside = `${OFF_FILE}.corrupt-${T0}`;
      expect((tcl as unknown as Seam).pendingOffWhenOnline.size).toBe(0);
      expect(fsMock.renames).toEqual([{ from: OFF_FILE, to: aside }]);
      expect(fsMock.files.get(aside)).toBe(content);
      expect(fsMock.files.has(OFF_FILE)).toBe(false);
      expect(logSpy.error).toHaveBeenCalledWith(expect.stringContaining("CORRUPT"));
    },
  );

  it("an arm file that exists but cannot be read is logged loudly; a missing one (first run) is not", async () => {
    const quiet = new TclCloud("user", "pass");
    await settle();
    expect((quiet as unknown as Seam).pendingOffWhenOnline.size).toBe(0);
    expect(logSpy.error).not.toHaveBeenCalled();

    fsMock.failReads = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const tcl = new TclCloud("user", "pass");
    await settle();
    expect((tcl as unknown as Seam).pendingOffWhenOnline.size).toBe(0);
    expect(logSpy.error).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });

  it("restores every older format with its counters reset, ignoring the manual-off lock fields and malformed entries", async () => {
    fsMock.files.set(OFF_FILE, JSON.stringify({
      [GUEST]: { armedAt: T0 - 5_000, attempts: 3, lastSentAt: T0 - 1_000 }, // first release
      round1: { armedAt: T0 - 60_000, offConfirmedAt: T0 - 30_000, lockFailedAt: T0 - 40_000 },
      round3: { armedAt: T0 - 50_000, lockRecorded: true, offConfirmedAt: null },
      current: { armedAt: T0 - 40_000, epochAt: T0 - 20_000 },
      junk: { armedAt: "yesterday" },
      nothing: null,
    }));

    const tcl = new TclCloud("user", "pass");
    const seam = tcl as unknown as Seam;
    await until(() => seam.pendingOffWhenOnline.size === 4);

    const fresh = { attempts: 0, lastSentAt: 0 };
    expect(seam.pendingOffWhenOnline.get(GUEST)).toEqual({ deviceId: GUEST, armedAt: T0 - 5_000, epochAt: 0, ...fresh });
    expect(seam.pendingOffWhenOnline.get("round1")).toEqual({ deviceId: "round1", armedAt: T0 - 60_000, epochAt: 0, ...fresh });
    expect(seam.pendingOffWhenOnline.get("round3")).toEqual({ deviceId: "round3", armedAt: T0 - 50_000, epochAt: 0, ...fresh });
    expect(seam.pendingOffWhenOnline.get("current")).toEqual({ deviceId: "current", armedAt: T0 - 40_000, epochAt: T0 - 20_000, ...fresh });
    expect(tcl.isOffWhenOnlineArmed("round1")).toBe(true); // a lock-era "OFF confirmed" no longer means anything
  });

  it("F6: a persisted arm whose read lands after a disarm does not resurrect it (memory or file)", async () => {
    fsMock.files.set(OFF_FILE, JSON.stringify({ [GUEST]: { armedAt: T0 - 5_000 } }));
    fsMock.deferred = true;
    const tcl = new TclCloud("user", "pass");

    const cancelling = tcl.setOffWhenOnline(GUEST, false); // the owner cancels before the startup read lands
    await drainDeferredFs();
    await cancelling; // acknowledged only once a write without the arm completed

    expect(tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({});
  });

  it("F6: an arm made after construction keeps its own arm time when the older file lands", async () => {
    fsMock.files.set(OFF_FILE, JSON.stringify({ [GUEST]: { armedAt: T0 - 5_000 } }));
    fsMock.deferred = true;
    const tcl = new TclCloud("user", "pass");

    vi.setSystemTime(T0 + 1_000);
    void tcl.setOffWhenOnline(GUEST, true);
    await drainDeferredFs();

    expect((tcl as unknown as Seam).pendingOffWhenOnline.get(GUEST)?.armedAt).toBe(T0 + 1_000);
    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")[GUEST].armedAt).toBe(T0 + 1_000);
  });

  it("F6: arm then disarm with writes completing newest-first: the file and a restarted instance end disarmed", async () => {
    fsMock.deferred = true;
    const tcl = new TclCloud("user", "pass");
    void tcl.setOffWhenOnline(GUEST, true);
    void tcl.setOffWhenOnline(GUEST, false);
    await drainDeferredFs();

    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({});

    fsMock.deferred = false;
    const restarted = new TclCloud("user", "pass");
    await settle();
    expect(restarted.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect((restarted as unknown as Seam).pendingOffWhenOnline.size).toBe(0);
  });

  it("S4: an OFF a fetch saw ends a persisted arm durably: a restart before any step does not bring it back", async () => {
    fsMock.files.set(OFF_FILE, JSON.stringify({ [GUEST]: { armedAt: T0 - 5_000 } }));
    const tcl = new TclCloud("user", "pass");
    await until(() => tcl.isOffWhenOnlineArmed(GUEST));
    const h = await harness(tcl);

    h.report(0, 5); // the unit came back OFF, seen by a dashboard poll
    h.at(6_000);
    await h.poll();
    await settle();
    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({});

    const restarted = new TclCloud("user", "pass");
    await settle();
    expect(restarted.isOffWhenOnlineArmed(GUEST)).toBe(false);
  });

  it("init() waits for the startup read, so its first device fetch already reports a persisted arm", async () => {
    fsMock.files.set(OFF_FILE, JSON.stringify({ [GUEST]: { armedAt: T0 - 5_000 } }));
    fsMock.deferred = true;
    const tcl = new TclCloud("user", "pass");
    const seam = tcl as unknown as { loadCredentials: () => Promise<void> };
    let initReachedCredentials = false;
    seam.loadCredentials = vi.fn(async () => {
      initReachedCredentials = true;
      throw new Error("stop here");
    });

    const initializing = tcl.init().catch(() => undefined);
    await settle();
    expect(initReachedCredentials).toBe(false); // still waiting for the arm file

    await drainDeferredFs();
    await initializing;
    expect(initReachedCredentials).toBe(true);
    expect(tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);
  });
});

describe("R2: a cancel's acknowledgement waits on DURABLE state (offWhenOnlineDurablyAbsent)", () => {
  it("the dashboard's disarm after a fetch's terminal OFF ended the arm: no acknowledgement before that removal's write completed", async () => {
    fsMock.files.set(OFF_FILE, JSON.stringify({ [GUEST]: { armedAt: T0 - 5_000 } }));
    const tcl = new TclCloud("user", "pass");
    await until(() => tcl.isOffWhenOnlineArmed(GUEST));
    const h = await harness(tcl);
    fsMock.deferred = true; // a slow disk
    h.report(0, 5); // the unit came back OFF, seen by a dashboard poll
    h.at(6_000);
    await h.poll();
    await settle();
    expect(tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(fsMock.pendingWrites).toHaveLength(1); // the removal's write is under way

    let acknowledged = false;
    const disarming = tcl.setOffWhenOnline(GUEST, false).then(() => { acknowledged = true; });
    await settle();
    expect(acknowledged).toBe(false);

    await drainDeferredFs();
    await disarming;
    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({});
  });

  it("nothing armed and the file never held the device: resolves at once, writing nothing", async () => {
    const tcl = new TclCloud("user", "pass");
    await settle(); // the startup read (no file)

    await tcl.offWhenOnlineDurablyAbsent(GUEST);

    expect(offFileWrites()).toEqual([]);
  });

  it("after a FAILED removal write it writes again: rejects when that write fails too, resolves once one succeeds", async () => {
    const tcl = new TclCloud("user", "pass");
    await tcl.setOffWhenOnline(GUEST, true);
    fsMock.failWrites = Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    tcl.cancelOffWhenOnline(GUEST, REASON);
    await settle();
    expect(logSpy.error).toHaveBeenCalledWith(expect.stringContaining("Could not save the off-when-back-online arms"));
    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({ [GUEST]: { armedAt: T0, epochAt: 0 } });

    await expect(tcl.offWhenOnlineDurablyAbsent(GUEST)).rejects.toThrow("EIO");
    fsMock.failWrites = null;
    await tcl.offWhenOnlineDurablyAbsent(GUEST);

    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({});
  });

  it("a write already running when the cancel came (its snapshot still holds the arm) is not enough: it waits for a newer write", async () => {
    const tcl = new TclCloud("user", "pass");
    await settle();
    fsMock.deferred = true;
    void tcl.setOffWhenOnline(GUEST, true); // its write snapshots the arm, then waits on the disk
    await settle();
    expect(fsMock.pendingWrites).toHaveLength(1);

    tcl.cancelOffWhenOnline(GUEST, REASON);
    let resolved = false;
    const asking = tcl.offWhenOnlineDurablyAbsent(GUEST).then(() => { resolved = true; });
    for (const write of fsMock.pendingWrites.splice(0)) write.settle(); // the arm's own write lands
    await settle();
    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({ [GUEST]: { armedAt: T0, epochAt: 0 } });
    expect(resolved).toBe(false);

    await drainDeferredFs();
    await asking;
    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({});
  });

  it("a pending write that never held the device (another device's arm) neither delays nor fails its acknowledgement", async () => {
    const tcl = new TclCloud("user", "pass");
    await settle(); // the startup read (no file)
    fsMock.failWrites = Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    const otherArm = tcl.setOffWhenOnline("OTHER", true).catch(() => undefined); // its write is running, and will fail

    await tcl.offWhenOnlineDurablyAbsent(GUEST);

    await otherArm;
    expect(tcl.isOffWhenOnlineArmed("OTHER")).toBe(true);
  });

  it("asked before the startup read settled: waits for a write after the read (the file may hold the arm)", async () => {
    fsMock.files.set(OFF_FILE, JSON.stringify({ [GUEST]: { armedAt: T0 - 5_000 } }));
    fsMock.deferred = true;
    const tcl = new TclCloud("user", "pass");

    tcl.cancelOffWhenOnline(GUEST, REASON);
    let resolved = false;
    const asking = tcl.offWhenOnlineDurablyAbsent(GUEST).then(() => { resolved = true; });
    await settle();
    expect(resolved).toBe(false);

    await drainDeferredFs();
    await asking;
    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({});
  });

  it("armed again since the cancel (newer intent): resolves at once, there is no cancel left to make durable", async () => {
    const tcl = new TclCloud("user", "pass");
    await tcl.setOffWhenOnline(GUEST, true);
    fsMock.deferred = true;
    tcl.cancelOffWhenOnline(GUEST, REASON);
    void tcl.setOffWhenOnline(GUEST, true);

    let resolved = false;
    const asking = tcl.offWhenOnlineDurablyAbsent(GUEST).then(() => { resolved = true; });
    await settle();
    expect(resolved).toBe(true);

    await drainDeferredFs();
    await asking;
    expect(Object.keys(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null"))).toEqual([GUEST]);
  });
});

describe("D2: a cancel's acknowledgement re-checks durable absence after every write it waited for", () => {
  /** Settle (or fail with `err`) the arm-file write held on the disk now (its temp file is written first). */
  async function completeArmWrite(err?: Error): Promise<void> {
    const index = fsMock.pendingWrites.findIndex((write) => write.path === `${OFF_FILE}.tmp`);
    if (index < 0) throw new Error("no arm-file write is held");
    const [write] = fsMock.pendingWrites.splice(index, 1);
    if (err) write.fail(err);
    else write.settle();
    await settle();
  }

  /** The device ids in the arm-file write held now (sorted), if any. */
  function heldArmWriteIds(): string[] | null {
    const write = fsMock.pendingWrites.find((pending) => pending.path === `${OFF_FILE}.tmp`);
    return write ? Object.keys(JSON.parse(write.data) as Record<string, unknown>).sort() : null;
  }

  /**
   * Guest armed and saved. With the disk slow, another device's arm write is
   * running (its snapshot holds Guest); the dashboard cancels Guest, so its
   * acknowledgement joins the removal write queued behind it; Guest is re-armed
   * before that write runs, so the write snapshots the NEWER arm when it does
   * and is held in turn; a fetch then sees the unit report OFF, which ends the
   * newer arm and queues another removal. Returns the acknowledgement as it
   * stood when it settled.
   */
  async function rearmedUnderTheJoinedWrite() {
    const tcl = new TclCloud("user", "pass");
    await tcl.setOffWhenOnline(GUEST, true);
    const h = await harness(tcl);
    fsMock.deferred = true;
    void tcl.setOffWhenOnline("OTHER", true).catch(() => undefined);
    await settle();
    expect(heldArmWriteIds()).toEqual([GUEST, "OTHER"].sort());

    const ack = { state: "pending", armed: null as boolean | null, file: null as Record<string, unknown> | null, error: "" };
    const acknowledging = tcl.setOffWhenOnline(GUEST, false).then(
      () => Object.assign(ack, { state: "resolved", armed: tcl.isOffWhenOnlineArmed(GUEST), file: JSON.parse(fsMock.files.get(OFF_FILE) ?? "{}") }),
      (err: Error) => Object.assign(ack, { state: "rejected", armed: tcl.isOffWhenOnlineArmed(GUEST), error: err.message }),
    );
    h.at(1_000);
    h.arm(); // newer intent, before the joined removal write has run
    await completeArmWrite(); // the other device's write lands: the joined write runs now
    expect(heldArmWriteIds()).toEqual([GUEST, "OTHER"].sort()); // ...with the newer arm in its snapshot

    h.report(0, 5); // the unit came back OFF, seen by a dashboard poll: the newer arm ends
    h.at(6_000);
    await h.poll();
    expect(tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    return { tcl, ack, acknowledging };
  }

  it("the joined write SUCCEEDS with the newer arm in it: no acknowledgement while the file holds Guest and its removal is still queued; it comes once a write excludes Guest", async () => {
    const { ack, acknowledging } = await rearmedUnderTheJoinedWrite();

    await completeArmWrite();
    expect(Object.keys(JSON.parse(fsMock.files.get(OFF_FILE) ?? "{}"))).toContain(GUEST);
    expect(ack.state).toBe("pending");

    await drainDeferredFs();
    await acknowledging;
    expect(ack).toMatchObject({ state: "resolved", armed: false });
    expect(Object.keys(ack.file ?? {})).toEqual(["OTHER"]);
  });

  it("the joined write FAILS with the newer arm in it: that failure is not taken for a saved cancel; the acknowledgement resolves once the later removal is saved", async () => {
    const { ack, acknowledging } = await rearmedUnderTheJoinedWrite();

    await completeArmWrite(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
    expect(Object.keys(JSON.parse(fsMock.files.get(OFF_FILE) ?? "{}"))).toContain(GUEST);
    expect(ack.state).toBe("pending");

    await drainDeferredFs();
    await acknowledging;
    expect(ack).toMatchObject({ state: "resolved", armed: false });
    expect(Object.keys(ack.file ?? {})).toEqual(["OTHER"]);
  });

  it("the joined write fails and so does every later one: the acknowledgement rejects, since the cancel is not saved", async () => {
    const { ack, acknowledging } = await rearmedUnderTheJoinedWrite();

    await completeArmWrite(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
    while (heldArmWriteIds() != null) await completeArmWrite(Object.assign(new Error("EIO: still failing"), { code: "EIO" }));
    await acknowledging;

    expect(ack).toMatchObject({ state: "rejected", armed: false, error: "EIO: still failing" });
    expect(Object.keys(JSON.parse(fsMock.files.get(OFF_FILE) ?? "{}"))).toContain(GUEST); // what a restart would read
  });

  it("re-armed after the removal write it waits for has run: that write failing does not reject it while the newer arm stands (no cancel is left to save)", async () => {
    const tcl = new TclCloud("user", "pass");
    await tcl.setOffWhenOnline(GUEST, true);
    fsMock.deferred = true;
    let state = "pending";
    const acknowledging = tcl.setOffWhenOnline(GUEST, false).then(() => { state = "resolved"; }, () => { state = "rejected"; });
    await settle();
    expect(heldArmWriteIds()).toEqual([]); // the removal write runs, without Guest
    vi.setSystemTime(T0 + 1_000);
    void tcl.setOffWhenOnline(GUEST, true).catch(() => undefined); // newer intent

    await completeArmWrite(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
    await acknowledging;

    expect(state).toBe("resolved");
    expect(tcl.isOffWhenOnlineArmed(GUEST)).toBe(true);
  });

  it(`bounded: re-armed and removed again around every write it waits for, it rejects with a clear error after ${OFF_WHEN_ONLINE_DURABLE_MAX_WRITES} writes instead of waiting forever`, async () => {
    const tcl = new TclCloud("user", "pass");
    await tcl.setOffWhenOnline(GUEST, true);
    fsMock.deferred = true;
    void tcl.setOffWhenOnline("OTHER", true).catch(() => undefined); // running, with Guest in its snapshot
    await settle();
    let outcome = "pending";
    const acknowledging = tcl.setOffWhenOnline(GUEST, false).then(
      () => { outcome = "resolved"; },
      (err: Error) => { outcome = err.message; },
    );

    for (let round = 1; round <= OFF_WHEN_ONLINE_DURABLE_MAX_WRITES + 5 && outcome === "pending"; round++) {
      vi.setSystemTime(T0 + round * 1_000);
      void tcl.setOffWhenOnline(GUEST, true).catch(() => undefined); // re-armed before the write it waits for runs
      await completeArmWrite(); // the write ahead lands: the awaited write runs, with Guest
      tcl.cancelOffWhenOnline(GUEST, REASON); // removed again while that write is held
      await completeArmWrite(); // it lands holding Guest: neither armed nor out of the file
    }
    await acknowledging;

    expect(outcome).toBe(`the arm file may still hold ${GUEST} after ${OFF_WHEN_ONLINE_DURABLE_MAX_WRITES} writes (it kept being armed and removed while the cancel waited)`);
  });
});

// ---------------------------------------------------------------------------
// Leader decisions 2026-10-10 on the repair round's open concerns.
// ---------------------------------------------------------------------------

describe("C1: the control route's early cancel (public cancelOffWhenOnline)", () => {
  it("drops the arm loudly with the caller's reason and persists the disarm", async () => {
    const tcl = new TclCloud("user", "pass");
    await tcl.setOffWhenOnline(GUEST, true);

    tcl.cancelOffWhenOnline(GUEST, REASON);
    await tcl.offWhenOnlineDurablyAbsent(GUEST);

    expect(tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(logSpy.info).toHaveBeenCalledWith(expect.stringContaining(`${GUEST} disarmed: ${REASON}`));
    expect(offFileWrites().at(-1)).toEqual({});
  });

  it("a persisted arm whose startup read lands after the cancel stays cancelled", async () => {
    fsMock.files.set(OFF_FILE, JSON.stringify({ [GUEST]: { armedAt: T0 - 5_000 } }));
    fsMock.deferred = true;
    const tcl = new TclCloud("user", "pass");

    void tcl.cancelOffWhenOnline(GUEST, REASON);
    await drainDeferredFs();

    expect(tcl.isOffWhenOnlineArmed(GUEST)).toBe(false);
    expect(JSON.parse(fsMock.files.get(OFF_FILE) ?? "null")).toEqual({});
  });
});

describe("C2: Smart AC Leveling ACs are out of scope", () => {
  it("TclCloud refuses to arm a leveling-eligible AC: warned, not armed, nothing persisted", async () => {
    const tcl = new TclCloud("user", "pass");

    await tcl.setOffWhenOnline(ABDU, true);

    expect(tcl.isOffWhenOnlineArmed(ABDU)).toBe(false);
    expect((tcl as unknown as Seam).pendingOffWhenOnline.has(ABDU)).toBe(false);
    expect(logSpy.warn).toHaveBeenCalledWith(expect.stringContaining(`Refusing off-when-back-online for ${ABDU}`));
    await settle();
    expect(offFileWrites()).toEqual([]);
  });

  it("disarming a leveling-eligible AC is still accepted (a no-op when nothing is armed)", async () => {
    const tcl = new TclCloud("user", "pass");

    await expect(tcl.setOffWhenOnline(ABDU, false)).resolves.toBeUndefined();
    expect(tcl.isOffWhenOnlineArmed(ABDU)).toBe(false);
  });

  it("the startup load ignores a persisted leveling-eligible arm with a warning and rewrites the file without it", async () => {
    fsMock.files.set(OFF_FILE, JSON.stringify({
      [GUEST]: { armedAt: T0 - 5_000 },
      [ABDU]: { armedAt: T0 - 5_000 },
    }));

    const tcl = new TclCloud("user", "pass");
    await until(() => tcl.isOffWhenOnlineArmed(GUEST));

    const seam = tcl as unknown as Seam;
    expect(seam.pendingOffWhenOnline.has(ABDU)).toBe(false);
    expect(seam.pendingOffWhenOnline.size).toBe(1);
    expect(logSpy.warn).toHaveBeenCalledWith(expect.stringContaining(ABDU));
    await until(() => offFileWrites().length >= 1);
    expect(Object.keys(offFileWrites().at(-1) ?? {})).toEqual([GUEST]);
  });
});
