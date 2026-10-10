// Seeded, deterministic randomized model tests for "turn off once back online"
// (2026-10-10). The third review FIX-FIRST on the same two mechanisms found one
// more interleaving in each, so each mechanism's invariant is restated here as a
// predicate and the interleaving space is searched against it, so the next
// corner case shows up here rather than in review:
//
//  - M1, the publish records the observed-off classifier reads (collector.ts):
//    an OFF report R is ours only through a record P that counts (not voided,
//    newer than the last server ON) and was published at or before R (to the
//    second: AWS stamps whole seconds), while P is unexpired and unmatched or
//    already pinned to a report at or after R; no record is ever pinned to a
//    report before its publish; a voided record never makes anything ours.
//    And the converse: every OFF such a record witnesses IS ours, however late
//    and out of order it is presented again, so our own OFF (the unit's report
//    of an accepted publish) never reads as a human's.
//  - M2, the durable acknowledgement of a cancel (`offWhenOnlineDurablyAbsent`,
//    tcl-cloud.ts): it resolves only while the device is armed in memory, or
//    absent from the arm file and from every write that snapshotted it; it
//    rejects only while the device is unarmed and the latest write, which tried
//    to exclude it, failed with nothing newer queued; no wait hangs once the
//    writes settle; a restart after an acknowledgement never revives the arm.
//
// Both drive the REAL code: the collector's record, classifier, pin and step
// rollback functions, and TclCloud's arm store, write queue and durability wait.
// Only the cloud edges (M1) and the disk (M2) are simulated. The PRNG is a small
// seeded mulberry32 (no dependency). A failure names the first failing seed and
// prints the operation list shrunk to a minimal one that still fails.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M2's disk. Only the arm file is controlled: every write of its temp file is
 * held until the model starts, completes or fails it, and the rename over the
 * target is held the same way (a crash in between leaves the previous file).
 * Each write is tagged with the TclCloud instance generation that issued it; a
 * restart kills the old instance's pending write (it never settles).
 */
interface DiskWrite {
  gen: number;
  /** The device ids its snapshot holds. */
  ids: string[];
  stage: "temp" | "rename" | "done" | "failed" | "dead";
  /** Complete the stage it is held in now. */
  advance: () => void;
  fail: (err: Error) => void;
  /** Complete the rename as soon as it is asked for (a write told to succeed while still at its temp stage). */
  autoRename: boolean;
}
const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writes: [] as DiskWrite[],
  gen: 0,
}));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const target = "/app/data/ac-off-when-online.json";
  const temp = `${target}.tmp`;
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const move = (from: string, to: string): void => {
    const data = disk.files.get(from);
    if (data == null) throw enoent(from);
    disk.files.delete(from);
    disk.files.set(to, data);
  };
  return {
    ...actual,
    readFile: vi.fn(async (path: string) => {
      const content = disk.files.get(String(path));
      if (content == null) throw enoent(String(path));
      return content;
    }),
    writeFile: vi.fn((path: string, data: string) => {
      const p = String(path);
      if (p !== temp) {
        disk.files.set(p, String(data));
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const write: DiskWrite = {
          gen: disk.gen,
          ids: Object.keys(JSON.parse(String(data)) as Record<string, unknown>),
          stage: "temp",
          autoRename: false,
          advance: () => {
            disk.files.set(p, String(data));
            write.stage = "rename";
            write.advance = () => undefined;
            write.fail = () => undefined;
            resolve();
          },
          fail: (err) => {
            write.stage = "failed";
            reject(err);
          },
        };
        disk.writes.push(write);
      });
    }),
    rename: vi.fn((from: string, to: string) => {
      const [f, t] = [String(from), String(to)];
      if (t !== target) {
        try {
          move(f, t);
          return Promise.resolve();
        } catch (err) {
          return Promise.reject(err);
        }
      }
      const write = disk.writes.find((w) => w.gen === disk.gen && w.stage === "rename");
      if (!write) return Promise.reject(new Error("rename of the arm file with no write at its rename stage"));
      return new Promise<void>((resolve, reject) => {
        write.advance = () => {
          move(f, t);
          write.stage = "done";
          resolve();
        };
        write.fail = (err) => {
          write.stage = "failed";
          reject(err);
        };
        if (write.autoRename) write.advance();
      });
    }),
  };
});

vi.mock("./logger.js", () => {
  const quiet = () => undefined;
  return { childLogger: () => ({ info: quiet, warn: quiet, error: quiet, debug: quiet }) };
});

import { TclCloud, type AcDevice, type OffWhenOnlineArm } from "./tcl-cloud.js";
import { Collector } from "./collector.js";
import type { Config } from "./config.js";

const GUEST = "DlXqDBFAAAE";
/** A second AC outside Smart AC Leveling, so writes also happen for a device the waits do not ask about. */
const OTHER = "OTHER";
const DEVICES = [GUEST, OTHER];
const ARM_FILE = "/app/data/ac-off-when-online.json";
/** A whole second, as AWS shadow metadata stamps are. */
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
/** The collector's AC_POWER_EVENT_GRACE_MS: an unmatched record expires after it. */
const EXPIRY_MS = 15 * 60_000;
const SEQUENCES = 2_000;
const MIN_OPS = 5;
const MAX_OPS = 30;

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

// ---------------------------------------------------------------------------
// Seeded search with shrinking
// ---------------------------------------------------------------------------

type Rand = () => number;

/** mulberry32: a small, well-mixed 32-bit PRNG; the same seed always gives the same stream. */
function prng(seed: number): Rand {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function int(rand: Rand, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

/** One of `choices`, drawn by weight. */
function weighted<T>(rand: Rand, choices: ReadonlyArray<readonly [number, () => T]>): T {
  const total = choices.reduce((sum, [weight]) => sum + weight, 0);
  let roll = rand() * total;
  for (const [weight, make] of choices) {
    roll -= weight;
    if (roll < 0) return make();
  }
  return choices[choices.length - 1][1]();
}

interface Model<Op> {
  generate: (rand: Rand) => Op[];
  /** Replays `ops` from a fresh state: the first violation found, or null. Appends a readable line per step to `trace`. */
  run: (ops: Op[], trace?: string[]) => Promise<string | null>;
}

/**
 * The kind of a violation: its message with the operation number, record ids,
 * times, wait labels and device ids taken out, so one kind groups every
 * sequence that broke the invariant the same way.
 */
function violationKind(failure: string): string {
  return failure
    .replace(/^after operation \d+ \((\w+)\): /, "$1: ")
    .replace(/^once every write completed: /, "drain: ")
    .replace(/#\d+(, #\d+)*/g, "#n")
    .replace(/\+-?\d+\.\d{3}s/g, "t")
    .replace(/\b([WA])\d+\b/g, "$1")
    .replace(/\d+(\.\d+)? min/g, "x min")
    .replace(/\((EIO[^)]*)\)/g, "")
    .replace(new RegExp(DEVICES.join("|"), "g"), "dev");
}

/** Remove chunks, then single operations, for as long as the sequence still fails with the same kind. */
async function shrink<Op>(ops: Op[], model: Model<Op>, kind: string): Promise<Op[]> {
  let current = ops;
  const sameKind = async (candidate: Op[]) => {
    const failure = await model.run(candidate);
    return failure != null && violationKind(failure) === kind;
  };
  for (let size = Math.max(1, Math.floor(current.length / 2)); size >= 1; size = Math.floor(size / 2)) {
    let removed = true;
    while (removed) {
      removed = false;
      for (let start = 0; start + size <= current.length; start++) {
        const candidate = [...current.slice(0, start), ...current.slice(start + size)];
        if (await sameKind(candidate)) {
          current = candidate;
          removed = true;
          break;
        }
      }
    }
  }
  return current;
}

/**
 * Runs SEQUENCES generated sequences. On failure throws with, for each kind of
 * violation found, how many sequences showed it, its first seed and that
 * sequence shrunk to a minimal one (a readable trace plus the operation list).
 */
async function search<Op>(name: string, model: Model<Op>): Promise<void> {
  let failing = 0;
  const kinds = new Map<string, { count: number; seed: number; ops: Op[] }>();
  for (let seed = 1; seed <= SEQUENCES; seed++) {
    const ops = model.generate(prng(seed));
    const failure = await model.run(ops);
    if (!failure) continue;
    failing += 1;
    const kind = violationKind(failure);
    const seen = kinds.get(kind);
    if (seen) seen.count += 1;
    else kinds.set(kind, { count: 1, seed, ops });
  }
  if (failing === 0) return;
  const reports: string[] = [];
  for (const [kind, { count, seed, ops }] of kinds) {
    const minimal = await shrink(ops, model, kind);
    const trace: string[] = [];
    const failure = await model.run(minimal, trace);
    reports.push(
      `- ${kind}\n  ${count} sequence(s); first failing seed ${seed} (${ops.length} operations), shrunk to ${minimal.length}:\n` +
        `${trace.join("\n")}\n  violation: ${failure}\n  minimal operations: ${JSON.stringify(minimal)}`,
    );
  }
  throw new Error(`${name}: ${failing} of ${SEQUENCES} sequences failed, ${kinds.size} kind(s) of violation:\n${reports.join("\n")}`);
}

/** How often each outcome a model must reach was reached, so a search that exercised nothing cannot pass. */
const reached = new Map<string, number>();
const reach = (outcome: string) => reached.set(outcome, (reached.get(outcome) ?? 0) + 1);

const secs = (ms: number) => `+${((ms - T0) / 1000).toFixed(3)}s`;
const floorSecond = (ms: number) => Math.floor(ms / 1000) * 1000;

// ---------------------------------------------------------------------------
// M1: the off-when-online publish records and the observed-off classifier
// ---------------------------------------------------------------------------

/**
 * `pick` chooses among the outstanding operations (modulo their count), and an
 * OFF report is dated from the clock or from a recent publish, so a shrunk
 * sequence still means something. A report is never later than the clock.
 * `ownOff` is the unit's own OFF report of an accepted publish (`pick` among
 * them), dated `delay` seconds after that publish's second the first time (one
 * report per publish: a later `ownOff` presents the same one); `represent` shows
 * a report presented before (`pick` among them) again, as a fetch that started
 * earlier and answers late does, so reports arrive out of order: any one, or
 * (`prefer: "late"`) one a newer report was presented after, our own OFFs first.
 */
type M1Op =
  | { kind: "publish" }
  | { kind: "retry"; pick: number }
  | { kind: "accept"; pick: number }
  | { kind: "reject"; pick: number; how: "error" | "superseded" }
  | { kind: "serverOn" }
  | { kind: "offReport"; via: "rule" | "seen"; anchor: "now" | "publish"; back: number; delta: number }
  | { kind: "ownOff"; via: "rule" | "seen"; pick: number; delay: number }
  | { kind: "represent"; via: "rule" | "seen"; prefer: "any" | "late"; pick: number }
  | { kind: "advance"; ms: number };

/** One OFF publish record of the collector's (`offWhenOnlineOffs`). */
interface OffRecord {
  id: number;
  publishedAt: number;
  voided: boolean;
  reportAt: number | null;
}

interface CollectorSeam {
  offWhenOnlineOffs: Map<string, OffRecord[]>;
  stepOffWhenOnline: (tcl: unknown, arm: OffWhenOnlineArm, token: number, device: AcDevice) => Promise<void>;
  noteServerAcOn: (deviceId: string, at: number) => void;
  isOffWhenOnlineOff: (deviceId: string) => boolean;
  pinSeenOffWhenOnlineOffs: (tcl: unknown) => void;
}

/** The reference model's view of one publish: what the cloud answered decides `voided`. */
interface RefRecord {
  record: OffRecord;
  publishedAt: number;
  voided: boolean;
  /** The publish the cloud accepted (its operation's last): the unit then reports its own OFF. */
  accepted: boolean;
  /** That own OFF's report, once the unit sent it (one per publish; later `ownOff`s present it again). */
  ownReportAt: number | null;
}

/** A report presented to the classifier: the accepted publishes it is the own OFF of, and its latest presentation. */
interface Presented {
  reportAt: number;
  owners: RefRecord[];
  /** The number of its latest presentation (presentations are numbered in order). */
  last: number;
}

/** A presentation to a rule, which asks the classifier. */
interface Classified {
  reportAt: number;
  ours: boolean;
  /** The accepted publishes this report is the own OFF of. */
  own: RefRecord[];
  /** Shown before, and a newer report was presented since: an out-of-order re-presentation. */
  outOfOrder: boolean;
}

/** One step operation of the collector, its OFF send held by the model. */
interface Operation {
  label: string;
  refs: RefRecord[];
  publish: () => void;
  settle: (outcome: "sent" | "superseded" | Error) => void;
  done: Promise<void>;
}

function generateM1(rand: Rand): M1Op[] {
  const count = int(rand, MIN_OPS, MAX_OPS);
  const ops: M1Op[] = [];
  for (let i = 0; i < count; i++) {
    ops.push(weighted<M1Op>(rand, [
      [4, () => ({ kind: "publish" })],
      [2, () => ({ kind: "retry", pick: int(rand, 0, 2) })],
      [4, () => ({ kind: "accept", pick: int(rand, 0, 2) })],
      [2, () => ({ kind: "reject", pick: int(rand, 0, 2), how: rand() < 0.5 ? "error" : "superseded" })],
      [1, () => ({ kind: "serverOn" })],
      [5, () => {
        const via = rand() < 0.5 ? "rule" : "seen";
        return rand() < 0.6
          ? { kind: "offReport", via, anchor: "publish", back: int(rand, 0, 2), delta: int(rand, -1, 2) }
          : { kind: "offReport", via, anchor: "now", back: 0, delta: int(rand, 0, 5) };
      }],
      [5, () => ({ kind: "ownOff", via: rand() < 0.5 ? "rule" : "seen", pick: int(rand, 0, 3), delay: int(rand, 0, 3) })],
      // Mostly to a rule: a rule's classification is what a lock hangs on.
      [4, () => ({ kind: "represent", via: rand() < 0.75 ? "rule" : "seen", prefer: rand() < 0.5 ? "late" : "any", pick: int(rand, 0, 7) })],
      [6, () => {
        const roll = rand();
        // Mostly sub-second to a few seconds (publishes and reports share or
        // straddle a second), sometimes minutes, sometimes past the 15-min expiry.
        const ms = roll < 0.6 ? int(rand, 1, 2_500) : roll < 0.9 ? int(rand, 5_000, 120_000) : int(rand, EXPIRY_MS - 2_000, EXPIRY_MS + 60_000);
        return { kind: "advance", ms };
      }],
    ]));
  }
  return ops;
}

/**
 * Does `ref` (not voided) witness the report `reportAt` being ours, per the
 * invariant's predicate, with `pin` its pinned report (by default as it stands)?
 */
function m1Witnesses(ref: RefRecord, reportAt: number, serverOnAt: number, now: number, pin = ref.record.reportAt): boolean {
  if (ref.publishedAt < serverOnAt) return false;
  if (floorSecond(ref.publishedAt) > reportAt) return false;
  return pin != null ? reportAt <= pin : now - ref.publishedAt < EXPIRY_MS;
}

/**
 * The records that owe a report its "ours" (completeness): every one that is
 * not voided and witnessed it before this presentation, by the pin it had then.
 * The design promises a pinned record until a newer server ON (or the 64-record
 * cap, which a sequence of at most MAX_OPS publishes never reaches) and an
 * unmatched one for the 15-min expiry. An own OFF reported after its publish
 * was already pinned to an earlier report is not owed: that earlier OFF settled
 * the publish (the shadow has no delta left), so the unit sends no OFF of ours
 * after it.
 */
function m1Owed(
  refs: readonly RefRecord[],
  pinsBefore: ReadonlyArray<number | null>,
  serverOnAt: number,
  now: number,
  reportAt: number,
): RefRecord[] {
  return refs.filter((ref, i) => !ref.voided && m1Witnesses(ref, reportAt, serverOnAt, now, i < pinsBefore.length ? pinsBefore[i] : null));
}

async function runM1(ops: M1Op[], trace?: string[]): Promise<string | null> {
  vi.setSystemTime(T0);
  const collector = new Collector({ query: async () => ({ rows: [], rowCount: 0 }) } as never, config);
  const cseam = collector as unknown as CollectorSeam;
  let snapshot: Array<Partial<AcDevice>> = [];
  collector.tclCloud = { getDevices: () => snapshot } as never;
  const refs: RefRecord[] = [];
  const outstanding: Operation[] = [];
  const presented: Presented[] = [];
  let presentations = 0;
  let outOfOrderOwn = false;
  let serverOnAt = 0;
  let operations = 0;
  const log = (line: string) => trace?.push(`  [${secs(Date.now())}] ${line}`);

  /**
   * Present the OFF report `reportAt`: to a rule, which asks the classifier
   * (the answer is returned), or to the step as an OFF a fetch ended the arm
   * on, which pins it. `owner` is the accepted publish it is the own OFF of.
   */
  const present = (reportAt: number, via: "rule" | "seen", owner: RefRecord | undefined, what: string): Classified | null => {
    const seen = presented.find((p) => p.reportAt === reportAt);
    const outOfOrder = seen != null && presented.some((p) => p.reportAt > reportAt && p.last > seen.last);
    const entry = seen ?? { reportAt, owners: [], last: 0 };
    if (!seen) presented.push(entry);
    if (owner && !entry.owners.includes(owner)) entry.owners.push(owner);
    entry.last = ++presentations;
    const label = `${what}OFF reported ${secs(reportAt)}${seen ? ` again${outOfOrder ? ", after a newer one" : ""}` : ""}`;
    if (via === "seen") {
      cseam.pinSeenOffWhenOnlineOffs({ takeOffWhenOnlineSeenOffs: () => [[GUEST, reportAt]] });
      log(`${label} that a fetch ended the arm on, pinned by the step`);
      return null;
    }
    snapshot = [{ id: GUEST, power: false, powerReportedAt: reportAt }];
    const ours = cseam.isOffWhenOnlineOff(GUEST);
    reach(ours ? "M1 OFF ours" : "M1 OFF not ours");
    log(`${label} presented to a rule: ${ours ? "ours" : "not ours"}`);
    return { reportAt, ours, own: [...entry.owners], outOfOrder };
  };

  for (const [index, op] of ops.entries()) {
    const now = Date.now();
    const pinsBefore = refs.map((ref) => ref.record.reportAt);
    let classified: Classified | null = null;
    const chosen = "pick" in op && outstanding.length > 0 ? outstanding[op.pick % outstanding.length] : undefined;

    switch (op.kind) {
      case "publish": {
        if (outstanding.length >= 3) {
          log("publish: three operations already outstanding (no-op)");
          break;
        }
        const label = String.fromCharCode(65 + operations++);
        const operation: Operation = {
          label,
          refs: [],
          publish: () => undefined,
          settle: () => undefined,
          done: Promise.resolve(),
        };
        const tcl = {
          isOffWhenOnlineOperationCurrent: () => true,
          finishOffWhenOnline: () => undefined,
          // The real step calls this once per operation; the model holds the
          // send and runs its publish boundary (onPublish) on demand.
          sendOffWhenOnline: (_arm: OffWhenOnlineArm, _token: number, onPublish: () => void) =>
            new Promise<"sent" | "superseded">((resolve, reject) => {
              operation.publish = () => {
                onPublish();
                const list = cseam.offWhenOnlineOffs.get(GUEST) ?? [];
                const ref: RefRecord = { record: list[list.length - 1], publishedAt: Date.now(), voided: false, accepted: false, ownReportAt: null };
                refs.push(ref);
                operation.refs.push(ref);
              };
              operation.settle = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
              operation.publish();
            }),
        };
        const arm: OffWhenOnlineArm = { deviceId: GUEST, armedAt: 0, epochAt: 0, attempts: 0, lastSentAt: 0 };
        const device = { id: GUEST, isOnline: true, lastSeenAt: now, power: true, powerReportedAt: null } as unknown as AcDevice;
        operation.done = cseam.stepOffWhenOnline(tcl, arm, 1, device).catch(() => undefined);
        outstanding.push(operation);
        const ref = operation.refs[0];
        log(ref ? `publish: operation ${label} publishes, record #${ref.record.id}` : `publish: operation ${label} published nothing`);
        break;
      }
      case "retry": {
        if (!chosen) {
          log("retry after 403: nothing outstanding (no-op)");
          break;
        }
        chosen.publish();
        log(`retry after 403: operation ${chosen.label}'s publish was refused; it publishes again, record #${chosen.refs[chosen.refs.length - 1].record.id}`);
        break;
      }
      case "accept":
      case "reject": {
        if (!chosen) {
          log(`${op.kind}: nothing outstanding (no-op)`);
          break;
        }
        outstanding.splice(outstanding.indexOf(chosen), 1);
        const accepted = op.kind === "accept";
        chosen.settle(accepted ? "sent" : op.how === "error" ? new Error("cloud down") : "superseded");
        await chosen.done;
        // Only the publish the cloud accepted stands: a re-auth retry follows a refused publish.
        chosen.refs.forEach((ref, i) => {
          if (!accepted || i < chosen.refs.length - 1) ref.voided = true;
          else ref.accepted = true;
        });
        if (chosen.refs.some((ref) => ref.voided)) reach("M1 record voided");
        log(accepted
          ? `accept: operation ${chosen.label}'s last publish accepted (record #${chosen.refs[chosen.refs.length - 1].record.id} stands)`
          : `reject (${op.how}): operation ${chosen.label} not accepted, all its records void`);
        break;
      }
      case "serverOn": {
        cseam.noteServerAcOn(GUEST, now);
        serverOnAt = now;
        log("server ON");
        break;
      }
      case "offReport": {
        const anchor = op.anchor === "publish" && refs.length > 0 ? refs[Math.max(0, refs.length - 1 - op.back)] : undefined;
        const reportAt = Math.min(
          floorSecond(now),
          anchor ? floorSecond(anchor.publishedAt) + op.delta * 1000 : floorSecond(now) - op.delta * 1000,
        );
        classified = present(reportAt, op.via, undefined, "");
        break;
      }
      case "ownOff": {
        const accepted = refs.filter((ref) => ref.accepted);
        if (accepted.length === 0) {
          log("own OFF: no accepted publish (no-op)");
          break;
        }
        const owner = accepted[op.pick % accepted.length];
        // At or after its publish's second, never later than the clock.
        owner.ownReportAt ??= Math.min(floorSecond(now), floorSecond(owner.publishedAt) + op.delay * 1000);
        classified = present(owner.ownReportAt, op.via, owner, `record #${owner.record.id}'s own `);
        break;
      }
      case "represent": {
        if (presented.length === 0) {
          log("present again: nothing presented yet (no-op)");
          break;
        }
        const late = presented.filter((p) => presented.some((q) => q.reportAt > p.reportAt && q.last > p.last));
        const lateOwn = late.filter((p) => p.owners.length > 0);
        const pool = op.prefer === "late" ? [lateOwn, late, presented].find((list) => list.length > 0) ?? presented : presented;
        const entry = pool[op.pick % pool.length];
        classified = present(entry.reportAt, op.via, undefined, entry.owners.length > 0 ? `record #${entry.owners[0].record.id}'s own ` : "");
        break;
      }
      case "advance": {
        vi.setSystemTime(now + op.ms);
        log(`advance ${(op.ms / 1000).toFixed(3)}s`);
        break;
      }
    }

    const failure = checkM1(refs, pinsBefore, serverOnAt, now, classified);
    if (failure) {
      log(`VIOLATION: ${failure}`);
      return `after operation ${index + 1} (${op.kind}): ${failure}`;
    }
    // Once per sequence: our own OFF, owed "ours", shown to a rule again after a newer report.
    if (!outOfOrderOwn && classified?.outOfOrder && m1Owed(refs, pinsBefore, serverOnAt, now, classified.reportAt).some((ref) => classified.own.includes(ref))) {
      outOfOrderOwn = true;
      reach("M1 own OFF re-presented out of order");
    }
  }
  return null;
}

function checkM1(
  refs: readonly RefRecord[],
  pinsBefore: ReadonlyArray<number | null>,
  serverOnAt: number,
  now: number,
  classified: Classified | null,
): string | null {
  for (const [i, ref] of refs.entries()) {
    const { id, reportAt, voided } = ref.record;
    const before = i < pinsBefore.length ? pinsBefore[i] : null;
    if (voided !== ref.voided) return `record #${id} has voided=${voided}, but its publish was ${ref.voided ? "not accepted" : "accepted or is still open"}`;
    if (reportAt == null) {
      if (before != null) return `record #${id} lost its pin`;
      continue;
    }
    // (b) a pin never precedes its publish.
    if (reportAt < floorSecond(ref.publishedAt)) {
      return `(b) record #${id} (published ${secs(ref.publishedAt)}) is pinned to the earlier report ${secs(reportAt)}`;
    }
    if (before != null && before !== reportAt) return `record #${id} was re-pinned from ${secs(before)} to ${secs(reportAt)}`;
    if (before == null) {
      // Pinned by this operation: the record must have counted at that moment.
      if (ref.voided) return `(c) the voided record #${id} was pinned to ${secs(reportAt)}`;
      if (ref.publishedAt < serverOnAt) return `record #${id} was pinned although a server ON came after it`;
      if (now - ref.publishedAt >= EXPIRY_MS) return `record #${id} was pinned ${((now - ref.publishedAt) / 60_000).toFixed(1)} min after its publish (expired)`;
    }
  }
  if (refs.some((ref, i) => ref.record.reportAt != null && (i >= pinsBefore.length || pinsBefore[i] == null))) reach("M1 record pinned");
  if (classified?.ours) {
    const witnesses = refs.filter((ref) => m1Witnesses(ref, classified.reportAt, serverOnAt, now));
    if (!witnesses.some((ref) => !ref.voided)) {
      return witnesses.length > 0
        ? `(c) the OFF reported ${secs(classified.reportAt)} is ours only through voided record(s) #${witnesses.map((r) => r.record.id).join(", #")}`
        : `(a) the OFF reported ${secs(classified.reportAt)} is ours, but no counted record published at or before it is unexpired or pinned at or after it`;
    }
  }
  // Completeness: a report a counted record witnessed before this presentation is ours.
  if (classified && !classified.ours) {
    const owed = m1Owed(refs, pinsBefore, serverOnAt, now, classified.reportAt);
    const ownOwed = owed.filter((ref) => classified.own.includes(ref));
    const again = classified.outOfOrder ? ", presented again after a newer report," : "";
    if (ownOwed.length > 0) {
      return `(d) our own OFF reported ${secs(classified.reportAt)} (of accepted record(s) #${ownOwed.map((r) => r.record.id).join(", #")})${again} is not ours: a human's, so a lock by the back door`;
    }
    if (owed.length > 0) {
      return `(e) the OFF reported ${secs(classified.reportAt)}${again} is not ours, although counted record(s) #${owed.map((r) => r.record.id).join(", #")} published at or before it are unexpired and unmatched or pinned at or after it`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// M2: the durable acknowledgement of a cancel
// ---------------------------------------------------------------------------

type M2Op =
  | { kind: "arm"; dev: number }
  | { kind: "cancelDashboard"; dev: number }
  | { kind: "cancelRoute"; dev: number }
  | { kind: "terminalOff"; dev: number }
  | { kind: "wait"; dev: number }
  | { kind: "writeStarts" }
  | { kind: "writeSucceeds" }
  | { kind: "writeFails" }
  | { kind: "restart" };

interface TclSeam {
  observeOffWhenOnline: (deviceId: string, power: boolean, powerReportedAt: number | null) => void;
  offWhenOnlineLastWrite: { settled: boolean } | null;
}

/** A promise the model watches: a durability wait, or an arm's acknowledgement (checked only for hangs). */
interface Watched {
  label: string;
  gen: number;
  settled: boolean;
}

function generateM2(rand: Rand): M2Op[] {
  const count = int(rand, MIN_OPS, MAX_OPS);
  const dev = () => (rand() < 0.8 ? 0 : 1);
  const ops: M2Op[] = [];
  for (let i = 0; i < count; i++) {
    ops.push(weighted<M2Op>(rand, [
      [4, () => ({ kind: "arm", dev: dev() })],
      [2, () => ({ kind: "cancelDashboard", dev: dev() })],
      [2, () => ({ kind: "cancelRoute", dev: dev() })],
      [2, () => ({ kind: "terminalOff", dev: dev() })],
      [2, () => ({ kind: "wait", dev: dev() })],
      [2, () => ({ kind: "writeStarts" })],
      [4, () => ({ kind: "writeSucceeds" })],
      [2, () => ({ kind: "writeFails" })],
      [1, () => ({ kind: "restart" })],
    ]));
  }
  return ops;
}

/** The current instance's write held on the disk now (writes are serialized: at most one). */
function heldWrite(): DiskWrite | undefined {
  return disk.writes.find((w) => w.gen === disk.gen && (w.stage === "temp" || w.stage === "rename"));
}

function armFileIds(): string[] {
  const raw = disk.files.get(ARM_FILE);
  return raw == null ? [] : Object.keys(JSON.parse(raw) as Record<string, unknown>);
}

/** Let every microtask the last operation queued run (writes start, waits settle), as between two requests. */
async function turn(): Promise<void> {
  for (let i = 0; i < 2; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Why a wait for `dev` may not resolve now, or null when it may. */
function resolveViolation(tcl: TclCloud, dev: string): string | null {
  if (tcl.isOffWhenOnlineArmed(dev)) return null;
  if (armFileIds().includes(dev)) return `${dev} is unarmed in memory but the arm file still holds it`;
  const pending = disk.writes.filter((w) => w.gen === disk.gen && (w.stage === "temp" || w.stage === "rename") && w.ids.includes(dev));
  if (pending.length > 0) return `${dev} is unarmed in memory but a pending write snapshotted it`;
  return null;
}

/** Why a wait for `dev` may not reject now, or null when it may. */
function rejectViolation(tcl: TclCloud, dev: string): string | null {
  if (tcl.isOffWhenOnlineArmed(dev)) return `${dev} is armed in memory`;
  const own = disk.writes.filter((w) => w.gen === disk.gen);
  const latest = own[own.length - 1];
  if (!latest) return "no write was ever attempted";
  if (latest.stage !== "failed") return `the latest write is ${latest.stage}, not failed`;
  if (latest.ids.includes(dev)) return `the latest write (failed) held ${dev}: it did not try to exclude it`;
  const queued = (tcl as unknown as TclSeam).offWhenOnlineLastWrite;
  if (queued && !queued.settled) return "a newer write is still queued";
  return null;
}

async function runM2(ops: M2Op[], trace?: string[]): Promise<string | null> {
  disk.files.clear();
  disk.writes.length = 0;
  disk.gen = 0;
  vi.setSystemTime(T0);
  let tcl = new TclCloud("user", "pass");
  await turn();
  const watched: Watched[] = [];
  /** Devices whose latest durable acknowledgement resolved while unarmed, with no arm since. */
  const ackedAbsent = new Set<string>();
  let violation: string | null = null;
  const log = (line: string) => trace?.push(`  [${secs(Date.now())}] ${line}`);
  const writeName = (w: DiskWrite) => `write #${disk.writes.indexOf(w) + 1} {${w.ids.join(", ")}}`;

  const watch = (promise: Promise<void>, dev: string, label: string, isWait: boolean) => {
    const entry: Watched = { label, gen: disk.gen, settled: false };
    const owner = tcl;
    watched.push(entry);
    promise.then(
      () => {
        entry.settled = true;
        if (!isWait) return;
        const failure = resolveViolation(owner, dev);
        log(`  ${label} resolved (memory ${owner.isOffWhenOnlineArmed(dev) ? "armed" : "unarmed"}, arm file {${armFileIds().join(", ")}})`);
        if (failure) violation ??= `${label} resolved while ${failure}`;
        else if (!owner.isOffWhenOnlineArmed(dev)) ackedAbsent.add(dev);
        reach(owner.isOffWhenOnlineArmed(dev) ? "M2 wait resolved armed" : "M2 wait resolved absent");
      },
      (err: Error) => {
        entry.settled = true;
        if (!isWait) return;
        const failure = rejectViolation(owner, dev);
        log(`  ${label} rejected: ${err.message}`);
        reach("M2 wait rejected");
        if (failure) violation ??= `${label} rejected while ${failure}`;
      },
    );
  };

  for (const [index, op] of ops.entries()) {
    vi.setSystemTime(Date.now() + 1_000);
    const n = index + 1;
    const dev = "dev" in op ? DEVICES[op.dev] : GUEST;
    switch (op.kind) {
      case "arm": {
        const rearm = tcl.isOffWhenOnlineArmed(dev);
        watch(tcl.setOffWhenOnline(dev, true), dev, `arm ack A${n}`, false);
        ackedAbsent.delete(dev);
        log(`${rearm ? "re-arm" : "arm"} ${dev}`);
        break;
      }
      case "cancelDashboard":
        watch(tcl.setOffWhenOnline(dev, false), dev, `dashboard cancel W${n} (${dev})`, true);
        log(`dashboard cancel of ${dev}: its acknowledgement is wait W${n}`);
        break;
      case "cancelRoute":
        tcl.cancelOffWhenOnline(dev, "cancelled by direct user power command");
        log(`control-route entry cancel of ${dev}`);
        break;
      case "terminalOff": {
        const armed = tcl.isOffWhenOnlineArmed(dev);
        (tcl as unknown as TclSeam).observeOffWhenOnline(dev, false, Date.now());
        log(`a fetch sees ${dev} report OFF${armed ? " (ends the arm)" : " (nothing armed)"}`);
        break;
      }
      case "wait":
        watch(tcl.offWhenOnlineDurablyAbsent(dev), dev, `route wait W${n} (${dev})`, true);
        log(`a route starts durability wait W${n} for ${dev}`);
        break;
      case "writeStarts": {
        const held = heldWrite();
        if (held?.stage === "temp") {
          held.advance();
          log(`${writeName(held)}: temp file written, its rename waits`);
        } else {
          log("write starts: no write at its temp stage (the queue just turns)");
        }
        break;
      }
      case "writeSucceeds": {
        const held = heldWrite();
        if (!held) {
          log("write succeeds: nothing held (no-op)");
          break;
        }
        held.autoRename = true; // at its temp stage: the rename completes as soon as it is asked for
        held.advance();
        log(`${writeName(held)} succeeds`);
        break;
      }
      case "writeFails": {
        const held = heldWrite();
        if (!held) {
          log("write fails: nothing held (no-op)");
          break;
        }
        const stage = held.stage;
        held.fail(new Error("EIO: i/o error"));
        log(`${writeName(held)} fails at its ${stage} stage`);
        break;
      }
      case "restart": {
        for (const w of disk.writes) if (w.gen === disk.gen && (w.stage === "temp" || w.stage === "rename")) w.stage = "dead";
        disk.gen += 1;
        tcl = new TclCloud("user", "pass");
        await turn();
        const armed = DEVICES.filter((d) => tcl.isOffWhenOnlineArmed(d));
        log(`restart: the new instance reads {${armFileIds().join(", ")}}, armed [${armed.join(", ")}]`);
        if (ackedAbsent.size > 0) reach("M2 restart after an acknowledged cancel");
        for (const d of ackedAbsent) {
          if (tcl.isOffWhenOnlineArmed(d)) violation ??= `the restart revived ${d}, whose cancel was acknowledged with no arm since`;
        }
        break;
      }
    }
    await turn();
    if (violation) {
      log(`VIOLATION: ${violation}`);
      return `after operation ${n} (${op.kind}): ${violation}`;
    }
  }

  // No more operations: every held write completes. Nothing may stay pending.
  for (let round = 0; round < 200; round++) {
    const held = heldWrite();
    if (!held) break;
    held.autoRename = true;
    held.advance();
    await turn();
  }
  if (heldWrite()) return "the arm-file writes never stopped once every write was allowed to complete";
  if (violation) {
    log(`VIOLATION while draining: ${violation}`);
    return `once every write completed: ${violation}`;
  }
  const hung = watched.filter((w) => w.gen === disk.gen && !w.settled).map((w) => w.label);
  if (hung.length > 0) {
    log(`HANG: ${hung.join(", ")}`);
    return `still pending after every write settled and no operation is left: ${hung.join(", ")}`;
  }
  return null;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("off when back online: seeded randomized model tests", () => {
  it(`M1: across ${SEQUENCES} random publish/refusal/retry/server-ON/OFF-report/own-OFF/re-presentation/clock sequences, an OFF is ours exactly when a counted record published at or before it is unexpired and unmatched or pinned at or after it (our own OFF included, however late and out of order it is presented again), a pin never precedes its publish, and a voided record never counts`, async () => {
    await search("M1 (records)", { generate: generateM1, run: runM1 });
    for (const outcome of ["M1 record voided", "M1 record pinned", "M1 OFF ours", "M1 OFF not ours", "M1 own OFF re-presented out of order"]) {
      expect(reached.get(outcome) ?? 0, outcome).toBeGreaterThan(50);
    }
  }, 300_000);

  it(`M2: across ${SEQUENCES} random arm/cancel/terminal-OFF/wait/write/restart sequences, a cancel's acknowledgement resolves only on durable absence (or a newer arm), rejects only on a failed exclusion with nothing newer queued, never hangs, and survives a restart`, async () => {
    await search("M2 (durability)", { generate: generateM2, run: runM2 });
    for (const outcome of ["M2 wait resolved armed", "M2 wait resolved absent", "M2 wait rejected", "M2 restart after an acknowledged cancel"]) {
      expect(reached.get(outcome) ?? 0, outcome).toBeGreaterThan(50);
    }
  }, 300_000);
});
