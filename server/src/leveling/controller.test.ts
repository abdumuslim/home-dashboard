import { describe, it, expect, vi } from "vitest";
import { LevelingControllerV2, batchLoadDirections } from "./controller.js";
import type { LevelingDeps } from "./api.js";
import { SUBFLOOR_WATCH_MS } from "./needs.js";
import { EXTERNAL_ON_DONOR_SHIELD_MS } from "./raise.js";
import { attemptedWithin, noteAttempt, noteFailure, restoreBounces, restoreFailures, type PacingState } from "./pacing.js";
import { baselineStale, noteFanSend, noteLevelSend, unconfirmedLevels, type ReconcilerState } from "./reconciler.js";
import { houseLoadAmps, type HouseLoadState } from "./house-load.js";
import { meterView } from "./sensing.js";
import { noteBatch, type ModeState } from "./modes.js";
import { powerEventRestartsAcs } from "./power-events.js";
import type { FanHolds } from "./fan-trim.js";
import type { MeterState } from "./types.js";

// Minimal in-memory mock of the Postgres pool the controller talks to. Only the
// tables the flavor re-sync touches are backed by mutable state; everything else
// returns an empty result set.
function createMockPool() {
  const configById = new Map<number, Record<string, unknown>>();
  const shed = new Set<string>();
  const fanHolds = new Map<string, { original_fan: number; last_set_fan: number }>();
  const remembered = new Map<string, number>();

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM ac_leveling_config") && sql.includes("id IN (1, 2)")) {
      const rows = [1, 2]
        .filter((id) => configById.has(id))
        .map((id) => ({ id, config: configById.get(id) }));
      return { rows, rowCount: rows.length };
    }
    const selectId = /SELECT config FROM ac_leveling_config WHERE id = (\d)/.exec(sql);
    if (selectId) {
      const id = Number(selectId[1]);
      return { rows: configById.has(id) ? [{ config: configById.get(id) }] : [], rowCount: configById.has(id) ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO ac_leveling_config")) {
      // Honour the row the statement actually targets — v1-shaped fields go to
      // row 1, the v2-owned flags to row 2 (2026-08-03).
      const id = Number(/VALUES \((\d)/.exec(sql)?.[1] ?? 2);
      configById.set(id, JSON.parse(String(params[0])));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM ac_leveling_shed")) {
      return {
        rows: Array.from(shed, (device_id) => ({ device_id, shed_at: new Date() })),
        rowCount: shed.size,
      };
    }
    if (sql.includes("FROM ac_leveling_fan_hold")) {
      return {
        rows: Array.from(fanHolds, ([device_id, h]) => ({ device_id, ...h, held_at: new Date() })),
        rowCount: fanHolds.size,
      };
    }
    if (sql.includes("FROM ac_leveling_remembered_level")) {
      return {
        rows: Array.from(remembered, ([device_id, level]) => ({ device_id, level })),
        rowCount: remembered.size,
      };
    }
    if (sql.includes("COUNT(*)") && sql.includes("ac_leveling_costs")) {
      return { rows: [{ n: 0 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  return { pool: { query } as never, configById, shed, fanHolds, remembered };
}

function createDeps(): LevelingDeps {
  return {
    getTclCloud: () => null,
    broadcast: async () => undefined,
    setDevicePowerCache: () => undefined,
    isManualOffLocked: async () => false,
    onLevelerFanCommand: () => undefined,
  };
}

describe("LevelingControllerV2 — acting-flavor re-sync", () => {
  it("re-syncs v1-written sheds and fan holds when the controller flag flips to v2", async () => {
    const mock = createMockPool();
    // Boot in shadow with empty persisted tables (v1 is acting).
    mock.configById.set(2, { controller: "shadow", enabled: true });
    const controller = new LevelingControllerV2(mock.pool, createDeps());
    await controller.ensureLoaded();
    expect(controller.controllerFlavor()).toBe("shadow");
    expect(controller.isShed("ac1")).toBe(false);
    expect(controller.hasFanHold("ac2")).toBe(false);

    // v1 (acting) sheds ac1 and puts a fan hold on ac2 — rows land in the DB but
    // v2's in-memory snapshot, loaded once at boot, doesn't know yet.
    mock.shed.add("ac1");
    mock.fanHolds.set("ac2", { original_fan: 0, last_set_fan: 1 });

    // Flip to v2 via the API (the cutover path).
    await controller.updateConfig({ controller: "v2" } as never);

    expect(controller.controllerFlavor()).toBe("v2");
    expect(controller.isShed("ac1")).toBe(true);
    expect(controller.hasFanHold("ac2")).toBe(true);
  });

  it("does not re-sync (or lose state) when the flag stays put", async () => {
    const mock = createMockPool();
    mock.configById.set(2, { controller: "v2", enabled: true });
    mock.shed.add("ac1");
    const controller = new LevelingControllerV2(mock.pool, createDeps());
    await controller.ensureLoaded();
    expect(controller.isShed("ac1")).toBe(true);

    // A later config save that does NOT change the flavor must not wipe state
    // via a spurious re-sync (prevFlavor already "v2").
    mock.shed.delete("ac1"); // stale DB change v2 shouldn't pick up on a no-op reload
    await controller.updateConfig({ raiseCalmSeconds: 25 } as never);
    expect(controller.controllerFlavor()).toBe("v2");
    expect(controller.isShed("ac1")).toBe(true);
  });

  it("persists v1-shaped fields to row 1 — a config save is not a no-op (2026-08-03)", async () => {
    // `collector.leveling()` routes every save to the ACTING controller, so
    // since the cutover this method has been the only writer — and it only ever
    // wrote its own five keys. Amp models, limits, boosts and priority went in
    // and vanished; the dashboard returned 200 and row 1 kept the cutover-date
    // values it had on 2026-07-24.
    const mock = createMockPool();
    mock.configById.set(1, { genLimitAmps: 15, genAmpModels: { ac1: { baseAmps: 2.3, stepAmps: 2.5 } }, priority: ["ac1"] });
    mock.configById.set(2, { controller: "v2", enabled: true });
    const controller = new LevelingControllerV2(mock.pool, createDeps());
    await controller.ensureLoaded();

    await controller.updateConfig({
      genAmpModels: { ac1: { baseAmps: 2.3, stepAmps: 1.5 } },
      restingBufferAmps: 0.3,
    } as never);

    expect(mock.configById.get(1)).toEqual({
      genLimitAmps: 15, // untouched keys survive — merged, never replaced
      genAmpModels: { ac1: { baseAmps: 2.3, stepAmps: 1.5 } },
      priority: ["ac1"],
    });
    // The v2-owned key still goes to its own row, and row 1 does not get it.
    expect(mock.configById.get(2)).toMatchObject({ controller: "v2", restingBufferAmps: 0.3 });
    expect(mock.configById.get(1)).not.toHaveProperty("restingBufferAmps");
  });
});

// ---------------------------------------------------------------------------
// The over-limit bucket's CAPACITY became config on 2026-09-05 (user: make the
// over-limit points changeable instead of the fixed 5). Three things live only
// in the shell: the row-2 routing of the new key, the status figure the card
// renders it with, and the live migration of a bucket whose capacity changed
// under it while an episode was in progress.
// ---------------------------------------------------------------------------
describe("LevelingControllerV2: configurable over-limit budget", () => {
  const bucketOf = (c: LevelingControllerV2) =>
    (c as unknown as { meterState: MeterState }).meterState.overLimitBudget;

  /** Deps whose TCL cloud exists, so `tick` gets past its null-cloud guard. */
  const actingDeps = (): LevelingDeps => ({
    ...createDeps(),
    getTclCloud: () => ({ sendControl: async () => undefined, executeAcAction: async () => undefined }) as never,
  });

  const ctxFor = (id: string) => [
    { device: acDevice(id, true, 1), managed: true, needTier: "full" as const, needDelta: 1, slotGenCap: null, slotKey: null },
  ];

  it("updateConfig routes overLimitBudgetPoints to row 2 and not to row 1", async () => {
    const mock = createMockPool();
    mock.configById.set(1, { genLimitAmps: 15 });
    mock.configById.set(2, { controller: "v2", enabled: true });
    const controller = new LevelingControllerV2(mock.pool, createDeps());
    await controller.ensureLoaded();

    await controller.updateConfig({ overLimitBudgetPoints: 8, genLimitAmps: 14 } as never);

    expect(mock.configById.get(2)).toMatchObject({ overLimitBudgetPoints: 8 });
    expect(mock.configById.get(1)).toEqual({ genLimitAmps: 14 });
    expect(mock.configById.get(1)).not.toHaveProperty("overLimitBudgetPoints");
  });

  it("status.overLimitBudgetMax reflects the configured capacity", async () => {
    const mock = createGradePool({
      overLimitBudgetPoints: 8,
      priority: ["a"],
      genAmpModels: { a: { baseAmps: 2, stepAmps: 2 } },
    });
    const controller = new LevelingControllerV2(mock.pool, actingDeps());
    await controller.ensureLoaded();

    // Before the first tick the fallback status answers from the loaded config.
    expect(controller.getStatus().overLimitBudgetMax).toBe(8);

    controller.onPowerReading({ current_1: 0, current_2: 10.2 } as never);
    await controller.tick(ctxFor("a"), 30);

    const status = controller.getStatus();
    expect(status.overLimitBudgetMax).toBe(8);
    // A calm line under the limit: the bucket is full at the CONFIGURED size,
    // so the card's "over-limit k/N points" hint counts down from 8.
    expect(status.overLimitBudget).toBe(8);
  });

  it("a PUT-driven capacity change migrates the LIVE bucket before it resolves", async () => {
    const mock = createMockPool();
    mock.configById.set(2, { controller: "v2", enabled: true, genLimitAmps: 15, marginAmps: 0.1, overLimitBudgetPoints: 8 });
    const controller = new LevelingControllerV2(mock.pool, actingDeps());
    await controller.ensureLoaded();

    // One severe reading (more than 1A over the 15A gen limit): 3 points spent.
    // The tick is what caches a status, so the GET below has one to be wrong.
    controller.onPowerReading({ current_1: 0, current_2: 17 } as never);
    expect(bucketOf(controller)).toBe(5);
    await controller.tick(ctxFor("a"), 30);
    expect(controller.getStatus().overLimitBudgetMax).toBe(8);

    await controller.updateConfig({ overLimitBudgetPoints: 4 } as never);

    // `updateConfig` ends in `reloadConfig`, so the transition is done before the
    // PUT answers. Spent debt survives the shrink (8 to 4 with 3 already spent),
    // which is what stops a knob change from forgiving a live episode.
    expect(bucketOf(controller)).toBe(1);

    // …and the card polls GET between ticks, so the CACHED status has to carry
    // the new pair immediately. Without another tick:
    const saved = controller.getStatus();
    expect(saved.overLimitBudgetMax).toBe(4);
    expect(saved.overLimitBudget).toBe(1);
    // The figure the card divides by can never be smaller than the figure it
    // shows, which is what an un-migrated bucket would have produced.
    expect(saved.overLimitBudget).toBeLessThanOrEqual(saved.overLimitBudgetMax);

    // The next real tick agrees with it.
    await controller.tick(ctxFor("a"), 30);
    const ticked = controller.getStatus();
    expect(ticked.overLimitBudgetMax).toBe(4);
    expect(ticked.overLimitBudget).toBe(1);
    expect(ticked.overLimitBudget).toBeLessThanOrEqual(ticked.overLimitBudgetMax);
  });
});

// ---------------------------------------------------------------------------
// Grade-queue integration (2026-07-25). `pendingGrade` used to be a single slot
// that every new batch overwrote, so on a busy generator episode NOTHING was
// ever graded: `ac_leveling_costs` still held its 2026-07-23 seeds after ~10
// live restores, and surviving attempts never reached `noteSuccess`, which pins
// the backoff ladder at its 15-min rung. It is a list now — which means a grade
// window can outlive the batch that FAILED its attempt, so the failure path has
// to strip that attempt or the backoff it just grew would be erased.
// ---------------------------------------------------------------------------

function createGradePool(
  configExtra: Record<string, unknown> = {},
  shedIds: string[] = [],
  /** Seed rows keyed like the CostBook: `${deviceId}|${source}|${transition}`. */
  book: Record<string, { ewmaAmps: number; samples: number; updatedAt: number }> = {},
  /** Persisted learned non-cooling holds (`ac_leveling_level_hold`). */
  levelHolds: Map<string, { level: number; outdoorC: number; observedAt: number }> = new Map(),
) {
  const journal: Array<Record<string, unknown>> = [];
  const costs: Array<{ deviceId: string; transition: string; ewma: number }> = [];
  /** Reasons written to `ac_leveling_shed` — a shed's own record of WHY. */
  const shedReasons: string[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("INSERT INTO ac_leveling_shed")) {
      shedReasons.push(String(params[1]));
      return { rows: [], rowCount: 1 };
    }
    // The learned non-cooling hold table — write-through, because a 6-hour hold
    // a deploy erases is not a hold (R14).
    if (sql.includes("INSERT INTO ac_leveling_level_hold")) {
      levelHolds.set(String(params[0]), {
        level: Number(params[1]),
        outdoorC: Number(params[2]),
        observedAt: Number(params[3]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM ac_leveling_level_hold")) {
      levelHolds.delete(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM ac_leveling_level_hold")) {
      const rows = Array.from(levelHolds, ([device_id, h]) => ({
        device_id,
        level: h.level,
        outdoor_c: h.outdoorC,
        observed_ms: h.observedAt,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM ac_leveling_costs") && sql.includes("ewma_amps")) {
      const rows = Object.entries(book).map(([key, v]) => {
        const [device_id, source, transition] = key.split("|");
        return { device_id, source, transition, ewma_amps: v.ewmaAmps, samples: v.samples, updated_ms: v.updatedAt };
      });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM ac_leveling_config") && sql.includes("id IN (1, 2)")) {
      return {
        rows: [
          {
            id: 2,
            config: { controller: "v2", enabled: true, genLimitAmps: 15, marginAmps: 0.1, ...configExtra },
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM ac_leveling_shed")) {
      return {
        rows: shedIds.map((device_id) => ({ device_id, shed_at: new Date() })),
        rowCount: shedIds.length,
      };
    }
    if (sql.includes("INSERT INTO ac_leveling_journal")) {
      journal.push({
        at: params[0],
        reason: params[4],
        requiredAmps: params[5],
        preAmps: params[6],
        commands: params[7],
        decisions: params[8],
      });
      return { rows: [{ id: journal.length }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO ac_leveling_costs")) {
      costs.push({ deviceId: String(params[0]), transition: String(params[2]), ewma: Number(params[3]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("COUNT(*)") && sql.includes("ac_leveling_costs")) return { rows: [{ n: 7 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as never, journal, costs, levelHolds, shedReasons };
}

function acDevice(id: string, power: boolean, generatorMode: number) {
  return { id, name: id, power, generatorMode, maxGeneratorLevel: 3, fanSpeed: 1 } as never;
}

// ---------------------------------------------------------------------------
// R13 — room-vs-room comparisons rank on REAL temperature (user, 2026-08-04:
// "coolest in real temp, not feels like"). `computeAcNeed` hands the leveler a
// FEELS-LIKE delta for a room whose range rule uses that metric and a
// real-temperature delta for every other room, so every cross-room comparison
// mixed units and humidity alone could make a milder room outrank a hotter one.
//
// The shell is what derives the shared-unit figure from the AC's own
// thermometer, so the guard belongs here: `scenarios.test.ts` is handed
// `roomTempC` directly and cannot see whether buildViews computed it.
// ---------------------------------------------------------------------------
describe("shed ranking on real temperature (2026-08-04)", () => {
  const twoRooms = async (opts: { coolTemp: number | undefined; coolNeed: number; hotTemp: number | undefined; hotNeed: number }) => {
    const mock = createGradePool({
      genLimitAmps: 15,
      priority: ["cool", "hot"],
      genAmpModels: { cool: { baseAmps: 2, stepAmps: 2 }, hot: { baseAmps: 2, stepAmps: 2 } },
    });
    const deps: LevelingDeps = {
      ...createDeps(),
      getTclCloud: () => ({ sendControl: async () => undefined, executeAcAction: async () => undefined }) as never,
    };
    const controller = new LevelingControllerV2(mock.pool, deps);
    await controller.ensureLoaded();
    const dev = (id: string, currentTemp: number | undefined) =>
      ({ ...(acDevice(id, true, 1) as object), currentTemp }) as never;
    const ctx = [
      { device: dev("cool", opts.coolTemp), managed: true, needTier: "full" as const, needDelta: opts.coolNeed, slotGenCap: null, slotKey: null },
      { device: dev("hot", opts.hotTemp), managed: true, needTier: "full" as const, needDelta: opts.hotNeed, slotGenCap: null, slotKey: null },
    ];
    let flip = 1;
    for (let i = 0; i < 10; i++) {
      flip = -flip;
      controller.onPowerReading({ current_1: 0, current_2: 15.6 + 0.01 * flip } as never);
      vi.advanceTimersByTime(5_000);
      await controller.tick(ctx, 30);
    }
    // The journal mock stores what the INSERT bound: commands arrive as JSON text.
    return mock.journal.flatMap(
      (r) => JSON.parse(String(r.commands ?? "[]")) as Array<{ kind: string; deviceId: string }>,
    );
  };

  it("sheds the room its thermometer says is cooler, not the one its own metric says is milder", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T10:00:00Z"));
      // `cool` carries the larger need on its own (feels-like) metric while its
      // ROOM is five degrees cooler. Pre-R13 the hot room paid.
      const commands = await twoRooms({ coolTemp: 27, coolNeed: 5, hotTemp: 32, hotNeed: 2 });
      const offs = commands.filter((c) => c.kind === "power_off");
      expect(offs).toHaveLength(1);
      expect(offs[0].deviceId).toBe("cool");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to each room's own metric when the thermometers are dead", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T10:00:00Z"));
      // No reading on either room → the ordering is exactly the pre-R13 one.
      const commands = await twoRooms({ coolTemp: undefined, coolNeed: 5, hotTemp: undefined, hotNeed: 2 });
      const offs = commands.filter((c) => c.kind === "power_off");
      expect(offs).toHaveLength(1);
      expect(offs[0].deviceId).toBe("hot");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Per-AC need override (user, 2026-08-05: "consider the room temp is what we
// get from the AC − 1°C, and the target is what is set"). The SENSOR
// calibration belongs in every room-vs-room comparison — otherwise the rooms
// are ranked on readings taken with differently-biased instruments — while the
// per-room SETPOINT preference must stay out of it (R13/50: which room is
// cooler is not that room's own business). `buildViews` is in the zone the
// scenario harness cannot see, so this file is the only net.
// ---------------------------------------------------------------------------
describe("per-AC need override in buildViews (2026-08-05)", () => {
  it("calibrates roomTempC by tempOffsetC and leaves the rank on the SHARED target", async () => {
    const mock = createGradePool({
      comfortTargetC: 25,
      needOverrides: { abdullah: { tempOffsetC: -1, targetFromSetpoint: true } },
    });
    const controller = new LevelingControllerV2(mock.pool, createDeps());
    await controller.ensureLoaded();

    const device = { ...(acDevice("abdullah", true, 1) as object), currentTemp: 35, targetTemp: 27 };
    const views = (
      controller as unknown as {
        buildViews: (
          ctx: unknown[],
          outdoorTempC: number | null,
          now: number,
        ) => Array<{ deviceId: string; roomTempC: number | null; rankNeedDelta: number }>;
      }
    ).buildViews([{ device, managed: true, needTier: "full", needDelta: 7, slotGenCap: null, slotKey: null }], 40, Date.now());

    expect(views[0].roomTempC).toBe(34);
    // 34 − 25, the shared comfort target. Had `targetFromSetpoint` leaked into
    // the ranking this would read 7 (34 − 27) and a room would be ordering the
    // house on its own occupant's preference.
    expect(views[0].rankNeedDelta).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// External-ON donor shield (2026-08-06 18:35–19:14Z, #9224/#9228). "Manual
// wins" (invariant 42) must cover the power button for the COMFORT tool: the
// leveler shed the priority-#1 room, a household member turned it back on three
// times, and the proactive swap re-selected it as DONOR and shed it again — a
// comfort optimisation un-doing a human's explicit ON. A bare power-button/
// dashboard ON mints no level pin, so the shell stamps `externalOnAt` and
// buildViews surfaces `recentlyExternalOn`, which `swapDonorFor` excludes. This
// state is shell-side (the swap arms in the pure layer off the view field, but
// the STAMP is here), so `scenarios.test.ts` cannot see it — this file is the
// only net.
// ---------------------------------------------------------------------------
describe("LevelingControllerV2 — external-ON donor shield", () => {
  const readViews = (controller: LevelingControllerV2, ctx: unknown[], now: number) =>
    (
      controller as unknown as {
        buildViews: (
          ctx: unknown[],
          outdoorTempC: number | null,
          now: number,
        ) => Array<{ deviceId: string; recentlyExternalOn?: boolean }>;
      }
    ).buildViews(ctx, 30, now);

  it("an external OFF→ON stamps it; a leveler restore-confirm does not; it expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T19:00:00Z"));
      // `b` boots shed — the room the leveler restores (its confirm is the
      // shed→on branch). `a` boots off-but-not-shed — the external branch.
      const mock = createGradePool({}, ["b"]);
      const deps: LevelingDeps = {
        ...createDeps(),
        getTclCloud: () =>
          ({
            sendControl: async () => undefined,
            executeAcAction: async () => undefined,
          }) as never,
      };
      const controller = new LevelingControllerV2(mock.pool, deps);
      await controller.ensureLoaded();

      const a = { id: "a", name: "a", power: false, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const b = { id: "b", name: "b", power: false, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const ctx = [
        { device: a as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
        { device: b as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
      ];
      let flip = 1;
      const run = async (steps: number) => {
        for (let i = 0; i < steps; i++) {
          flip = -flip;
          controller.onPowerReading({ current_1: 0, current_2: 8 + 0.01 * flip } as never);
          vi.advanceTimersByTime(5_000);
          await controller.tick(ctx, 30);
        }
      };

      // Both rooms off — establishes the prev-power baseline for the flips.
      await run(6);
      expect(readViews(controller, ctx, Date.now()).find((v) => v.deviceId === "a")?.recentlyExternalOn).toBe(false);

      // A household member switches `a` on at the wall: an OFF→ON flip of a room
      // the leveler never shed — the external branch. It is shielded.
      a.power = true;
      await run(2);
      const atExternalOn = Date.now();
      expect(readViews(controller, ctx, atExternalOn).find((v) => v.deviceId === "a")?.recentlyExternalOn).toBe(true);

      // `b`'s shadow confirms ON while it is SHED — the "restore_confirmed"
      // branch, where the leveler's own restores land. NOT a human, no shield.
      b.power = true;
      await run(2);
      expect(readViews(controller, ctx, Date.now()).find((v) => v.deviceId === "b")?.recentlyExternalOn).toBe(false);

      // Fifteen minutes on, `a` is a tradeable donor again.
      expect(readViews(controller, ctx, atExternalOn + EXTERNAL_ON_DONOR_SHIELD_MS).find((v) => v.deviceId === "a")?.recentlyExternalOn).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Shed observed-ON reconciliation vs the TCL send-to-confirm lag (#9268/#9270,
// 2026-08-07 04:15Z). At gen entry the leveler shed Najat and 17.4s later sent
// a GENUINE DUPLICATE power_off: `SHED_CLEAR_GRACE_MS` was 15s while TCL's
// confirm lag runs 5.8s–13min (invariant 4), so a stale still-ON shadow at
// 17.4s cleared the shed mid-flight, the recompute re-decided the room as "on,
// not shed" and re-sent, and the power_off dedupe was blind (it keys off the
// shedIds membership just wrongly cleared). Fix: 60s grace, AND tell an ON that
// followed an OBSERVED off (external hand — clear now + shield) apart from an ON
// with no off ever seen (the stale echo — keep the shed so confirm-or-resend
// re-sends it). A naive widen ALONE would re-shed a human's remote ON 20s after
// the shed — the #9224/#9228 "manual wins" class (invariant 42/57). This is a
// device-poll path scenarios.test.ts cannot see, so this file is the only net.
// ---------------------------------------------------------------------------
describe("LevelingControllerV2 — shed observed-ON vs confirm lag", () => {
  const tclStub = () =>
    ({ sendControl: async () => undefined, executeAcAction: async () => undefined }) as never;
  const readViews = (controller: LevelingControllerV2, ctx: unknown[], now: number) =>
    (
      controller as unknown as {
        buildViews: (
          ctx: unknown[],
          outdoorTempC: number | null,
          now: number,
        ) => Array<{ deviceId: string; recentlyExternalOn?: boolean }>;
      }
    ).buildViews(ctx, 30, now);

  it("a stale still-ON shadow 17s after a shed does not clear it (#9268/#9270 2026-08-07)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-07T04:15:00Z"));
      const mock = createGradePool({}, ["b"]);
      const controller = new LevelingControllerV2(mock.pool, { ...createDeps(), getTclCloud: tclStub });
      await controller.ensureLoaded();
      expect(controller.isShed("b")).toBe(true);
      // The off has NOT been observed — the shadow is still lying ON. 17.4s is
      // the exact live gap, and it straddled the old 15s grace.
      vi.advanceTimersByTime(17_400);
      await controller.reconcileObservedOn("b");
      expect(controller.isShed("b"), "kept: off never landed, inside the 60s grace").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an observed OFF then ON clears the shed immediately and shields the room", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-07T04:15:00Z"));
      const mock = createGradePool({}, ["b"]);
      const controller = new LevelingControllerV2(mock.pool, { ...createDeps(), getTclCloud: tclStub });
      await controller.ensureLoaded();
      const b = { id: "b", name: "b", power: false, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const ctx = [
        { device: b as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
      ];
      let flip = 1;
      const run = async (steps: number) => {
        for (let i = 0; i < steps; i++) {
          flip = -flip;
          // High on the 15A line so the shed room is never restorable — the only
          // thing that can clear the shed here is the reconcile below.
          controller.onPowerReading({ current_1: 0, current_2: 14 + 0.01 * flip } as never);
          vi.advanceTimersByTime(5_000);
          await controller.tick(ctx, 30);
        }
      };
      // Every tick sees the SHED room OFF — the power_off has landed on the shadow.
      await run(4);
      expect(controller.isShed("b")).toBe(true);
      // ~t+20s a poll finds it ON again: the off landed, then a hand — external.
      await controller.reconcileObservedOn("b");
      expect(controller.isShed("b"), "external hand — cleared with no grace").toBe(false);
      expect(
        readViews(controller, ctx, Date.now()).find((v) => v.deviceId === "b")?.recentlyExternalOn,
        "a remote re-enable of a shed room is shielded from the swap donor pick",
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no OFF ever observed: the grace expiry still clears (t+61s) and shields", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-07T04:15:00Z"));
      const mock = createGradePool({}, ["b"]);
      const controller = new LevelingControllerV2(mock.pool, { ...createDeps(), getTclCloud: tclStub });
      await controller.ensureLoaded();
      const ctx = [
        { device: acDevice("b", true, 1), managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
      ];
      expect(controller.isShed("b")).toBe(true);
      // Past the 60s grace with no off ever seen → clear as external/already-
      // cleared, and shield (over-shielding a comfort tool costs nothing).
      vi.advanceTimersByTime(61_000);
      await controller.reconcileObservedOn("b");
      expect(controller.isShed("b")).toBe(false);
      expect(
        readViews(controller, ctx, Date.now()).find((v) => v.deviceId === "b")?.recentlyExternalOn,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-08-08: a leveler restore's own shadow echo was misclassified as an
// EXTERNAL ON. `reconcileObservedOn` runs on the device poll BEFORE the tick,
// and per invariant 4 the shed stays set until the ON confirms — so the
// restore's echo arrives while the room is still shed, often AFTER its off was
// observed, and the "post-off ON = external hand" branch fired: it reset the
// bounce count (killing the invariant-67 compounding — the journal printed
// "1st bounce" across four real bounces) and stamped a bogus 15-min swap-donor
// shield on every room the leveler itself restored. The fix keys BOTH the
// reconcile branch and the tick's `!wasShed` fallback on `restoreInFlight` — the
// same restore-pacing signal the tick's `restore_confirmed` branch already
// trusts — so our own echo is graded a confirm, never a hand. Device-poll path
// scenarios.test.ts cannot see; this file is the only net.
// ---------------------------------------------------------------------------
describe("LevelingControllerV2 — a restore's own echo is not an external hand (2026-08-08)", () => {
  const tclStub = () =>
    ({ sendControl: async () => undefined, executeAcAction: async () => undefined }) as never;
  const pacingOf = (c: LevelingControllerV2) => (c as unknown as { pacing: PacingState }).pacing;
  const setPacing = (c: LevelingControllerV2, p: PacingState) => {
    (c as unknown as { pacing: PacingState }).pacing = p;
  };
  const readViews = (controller: LevelingControllerV2, ctx: unknown[], now: number) =>
    (
      controller as unknown as {
        buildViews: (
          ctx: unknown[],
          outdoorTempC: number | null,
          now: number,
        ) => Array<{ deviceId: string; recentlyExternalOn?: boolean }>;
      }
    ).buildViews(ctx, 30, now);

  // Drive ticks on a line too full to restore the shed room, so the ONLY thing
  // that can clear the shed is the reconcile/flip under test. Each tick the
  // shadow shows the room OFF stamps `shedOffObservedAt` — the shed's power_off
  // having landed, which is what the "post-off ON = external hand" branch reads.
  const bootObservedOff = async (controller: LevelingControllerV2, ctx: unknown[]) => {
    let flip = 1;
    for (let i = 0; i < 4; i++) {
      flip = -flip;
      controller.onPowerReading({ current_1: 0, current_2: 14 + 0.01 * flip } as never);
      vi.advanceTimersByTime(5_000);
      await controller.tick(ctx as never, 30);
    }
  };

  it("reconcileObservedOn during OUR restore clears the shed, keeps the bounces, and does NOT shield", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T09:00:00Z"));
      const mock = createGradePool({}, ["b"]);
      const controller = new LevelingControllerV2(mock.pool, { ...createDeps(), getTclCloud: tclStub });
      await controller.ensureLoaded();
      const ctx = [
        { device: acDevice("b", false, 1), managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
      ];
      await bootObservedOff(controller, ctx);
      expect(controller.isShed("b")).toBe(true);
      // Two bounces booked, and OUR restore is in flight (a `noteAttempt`).
      const now = Date.now();
      let p = pacingOf(controller);
      p = noteFailure(noteFailure(p, "b", "restore", now, true), "b", "restore", now, true);
      p = noteAttempt(p, "b", "restore", now);
      setPacing(controller, p);
      expect(restoreBounces(pacingOf(controller), "b")).toBe(2);
      // The restore's OWN ON echo arrives on the device poll (reconcile runs
      // BEFORE the tick, which is the production race the tick guard misses).
      await controller.reconcileObservedOn("b");
      expect(controller.isShed("b"), "our restore confirmed — the shed clears").toBe(false);
      expect(
        restoreBounces(pacingOf(controller), "b"),
        "a restore confirm must NOT reset the bounce count",
      ).toBe(2);
      expect(
        readViews(controller, ctx, Date.now()).find((v) => v.deviceId === "b")?.recentlyExternalOn,
        "our own restore never shields itself as a swap donor",
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconcileObservedOn with NO restore in flight is still an external hand (clears, un-bounces, shields)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T09:00:00Z"));
      const mock = createGradePool({}, ["b"]);
      const controller = new LevelingControllerV2(mock.pool, { ...createDeps(), getTclCloud: tclStub });
      await controller.ensureLoaded();
      const ctx = [
        { device: acDevice("b", false, 1), managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
      ];
      await bootObservedOff(controller, ctx);
      // A bounce stands, but NO restore was attempted — the ON is a genuine hand.
      const now = Date.now();
      setPacing(controller, noteFailure(pacingOf(controller), "b", "restore", now, true));
      expect(restoreBounces(pacingOf(controller), "b")).toBe(1);
      await controller.reconcileObservedOn("b");
      expect(controller.isShed("b"), "external hand — cleared").toBe(false);
      expect(restoreBounces(pacingOf(controller), "b"), "an external ON ends the episode").toBe(0);
      expect(
        readViews(controller, ctx, Date.now()).find((v) => v.deviceId === "b")?.recentlyExternalOn,
        "a remote re-enable of a shed room is shielded from the donor pick",
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the tick's !wasShed fallback does not stamp external after a restore-confirm cleared the shed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T09:00:00Z"));
      const mock = createGradePool({}, ["b"]);
      const controller = new LevelingControllerV2(mock.pool, { ...createDeps(), getTclCloud: tclStub });
      await controller.ensureLoaded();
      const b = { id: "b", name: "b", power: false, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const ctx = [
        { device: b as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
      ];
      await bootObservedOff(controller, ctx);
      // OUR restore is in flight; the device-poll reconcile clears the shed as a
      // confirm, so by tick time `b` is on-but-no-longer-shed (`wasShed` false).
      const now = Date.now();
      setPacing(controller, noteAttempt(pacingOf(controller), "b", "restore", now));
      await controller.reconcileObservedOn("b");
      expect(controller.isShed("b")).toBe(false);
      // The shadow now flips off→on on the tick: the `!wasShed` fallback would
      // stamp an external ON without the shared guard.
      b.power = true;
      controller.onPowerReading({ current_1: 0, current_2: 8 } as never);
      vi.advanceTimersByTime(5_000);
      await controller.tick(ctx, 30);
      expect(
        readViews(controller, ctx, Date.now()).find((v) => v.deviceId === "b")?.recentlyExternalOn,
        "the flip of a room the reconcile just restore-confirmed must not shield",
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-08-08: the house-load drop detector's memory froze across a restore→shed
// round trip, so a commanded off booked the dying compressor as house (7.2A
// phantom, live). The round trip completed inside the 240s ramp, so no tick
// advanced `lastModeledAmps`: the pendingOn stand-down skipped the sampleHouseLoad
// CALL between send and confirm, and the ramping early-return skipped the advance
// between confirm and ramp end. At the shed the modeled-now equalled the frozen
// stored total → NO drop detected → the cooldown never armed → the first tick
// booked smoothed − stale-modeled as house. The fix advances the memory on EVERY
// tick and a belt arms the cooldown on every commanded cut.
//
// SHELL test on purpose: scenario.ts cannot forge the device-poll pendingOn /
// shadow-confirm timing this replays.
// ---------------------------------------------------------------------------
describe("LevelingControllerV2 — a restore→shed round trip is not phantom house (2026-08-08)", () => {
  const tclStub = () =>
    ({ sendControl: async () => undefined, executeAcAction: async () => undefined }) as never;
  const houseOf = (c: LevelingControllerV2) => (c as unknown as { houseLoad: HouseLoadState }).houseLoad;
  const pacingOf = (c: LevelingControllerV2) => (c as unknown as { pacing: PacingState }).pacing;
  const setPacing = (c: LevelingControllerV2, p: PacingState) => {
    (c as unknown as { pacing: PacingState }).pacing = p;
  };
  const pendingOnOf = (c: LevelingControllerV2) =>
    (c as unknown as { pendingOn: Map<string, number> }).pendingOn;

  it("never books the dying compressor as house after the re-shed (cooldown armed)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
      const mock = createGradePool({ genAmpModels: { b: { baseAmps: 2, stepAmps: 2 } } }, ["b"]);
      const controller = new LevelingControllerV2(mock.pool, { ...createDeps(), getTclCloud: tclStub });
      await controller.ensureLoaded();
      const b = { id: "b", name: "b", power: false, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const ctx = [
        { device: b as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
      ];
      let flip = 1;
      const run = async (genAmps: number, steps: number) => {
        for (let i = 0; i < steps; i++) {
          flip = -flip;
          controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
          vi.advanceTimersByTime(5_000);
          await controller.tick(ctx, 30);
        }
      };

      // Establish the gen source first (the source-change resetPacing would wipe
      // any pacing set before it), then block b's auto-restore so the test — not
      // the planner — owns the restore timing (no attemptMeterAmps is set, so the
      // probe re-arm cannot override the backoff either).
      await run(6, 1);
      expect(controller.isShed("b")).toBe(true);
      let p = pacingOf(controller);
      for (let i = 0; i < 4; i++) p = noteFailure(p, "b", "restore", Date.now(), true);
      setPacing(controller, p);

      // Settle past the boot-quiet window with b shed: the meter is pure house
      // (b's model is out of the running set), sampled at ~6A tagged "".
      await run(6, 40);
      expect(houseOf(controller).gen?.lastModeledAmps).toBe(0);
      const honest = houseLoadAmps(houseOf(controller), "gen", Date.now(), []);
      expect(honest).toBeGreaterThan(4);
      expect(honest).toBeLessThan(8);

      // The restore ships — exactly what executeAndJournal's power_on does.
      pendingOnOf(controller).set("b", Date.now());
      await run(6, 2); // unconfirmed-ON stand-down: no sample, memory still 0
      expect(houseOf(controller).gen?.lastModeledAmps).toBe(0);

      // The shadow confirms: b flips on and RAMPS. The memory must rebase to
      // include b (2A) though no sample is taken — the step that used to freeze.
      b.power = true;
      await run(8, 1);
      expect(controller.isShed("b")).toBe(false);
      expect(controller.rampWindowOpen("b")).toBe(true);
      expect(houseOf(controller).gen?.lastModeledAmps).toBeCloseTo(2, 1);

      // Re-shed still inside the ramp: slam the line over the limit so the reducer
      // sheds b. The belt arms the house cooldown on the commanded cut, and the
      // modeled drop (2 → 0) is now visible to the detector too.
      vi.advanceTimersByTime(90_000);
      await run(24, 8);
      expect(controller.isShed("b")).toBe(true);
      expect(houseOf(controller).gen?.cooldownUntil ?? 0).toBeGreaterThan(Date.now());

      // The next readings carry b's dying compressor (~14A over a 0A model), but
      // the cooldown refuses them — the honest "" peak carries, never the phantom.
      await run(14, 3);
      expect(houseLoadAmps(houseOf(controller), "gen", Date.now(), [])).toBeLessThan(8);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LevelingControllerV2 — grade queue", () => {
  it("a bounced attempt keeps its ladder position — a stale grade must not mark it a success", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-25T18:00:00Z"));
      const mock = createGradePool();
      const device = acDevice("a", true, 1) as unknown as { generatorMode: number };
      const deps: LevelingDeps = {
        ...createDeps(),
        getTclCloud: () =>
          ({
            // A real firmware applies the level, so the next view reflects it —
            // otherwise the send-dedupe spacing masks the second raise.
            sendControl: async (_id: string, cmd: string, value: number) => {
              if (cmd === "set_generator_mode") device.generatorMode = value;
            },
            executeAcAction: async () => undefined,
          }) as never,
      };
      const controller = new LevelingControllerV2(mock.pool, deps);
      await controller.ensureLoaded();
      const ctx = [
        { device: device as never, managed: true, needTier: "full" as const, needDelta: 2, slotGenCap: null, slotKey: null },
      ];

      // A live CT always micro-jitters; a bit-identical stream would trip the
      // frozen-meter detector and suspend raises, testing the wrong path.
      let flip = 1;
      const run = async (genAmps: number, steps: number) => {
        for (let i = 0; i < steps; i++) {
          flip = -flip;
          controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
          vi.advanceTimersByTime(5_000);
          await controller.tick(ctx, 30);
        }
      };
      const raiseCooldown = () => controller.getStatus().acs[0]?.raiseCooldownMs ?? 0;

      // Bounce a raise so the cut lands INSIDE the raise's own grade window
      // (GRADE_LEVEL_MS 45s) — that is the only case where a stale grade could
      // later resolve an already-blamed attempt as a success.
      const bounce = async () => {
        await run(8, 8); // calm ≥ raiseCalmSeconds → a raise ships (~30s in)
        await run(15.5, 6); // 5 mild readings empty the bucket → cut at ~25s
      };

      await run(8, 24); // settle in and climb
      expect(device.generatorMode).toBeGreaterThan(1);

      await bounce();
      expect(raiseCooldown()).toBeGreaterThan(0); // failure #1 → ladder rung 1

      await bounce(); // failure #2 → rung 2 (120s) if the ladder survived

      // Sample AFTER the stale grade window would have resolved (~45s past the
      // raise, ~20s past the failure) but well inside rung 2's 120s cooldown.
      // With the strip: still cooling. Without it: the stale grade calls
      // noteSuccess and the backoff is silently erased to 0.
      await run(8, 6);
      expect(raiseCooldown()).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes durable blocked rows when an evaluation commands nothing", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-25T18:00:00Z"));
      const mock = createGradePool();
      const deps: LevelingDeps = {
        ...createDeps(),
        getTclCloud: () =>
          ({ sendControl: async () => undefined, executeAcAction: async () => undefined }) as never,
      };
      const controller = new LevelingControllerV2(mock.pool, deps);
      await controller.ensureLoaded();
      // One shed AC with no headroom at all — the restore is blocked every tick.
      const ctx = [
        { device: acDevice("a", true, 3), managed: true, needTier: "full" as const, needDelta: 2, slotGenCap: null, slotKey: null },
        { device: acDevice("b", false, 1), managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
      ];
      let flip = 1;
      for (let i = 0; i < 40; i++) {
        flip = -flip;
        controller.onPowerReading({ current_1: 0, current_2: 14.5 + 0.01 * flip } as never);
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctx, 30);
      }
      const blocked = mock.journal.filter((r) => r.reason === "blocked");
      expect(blocked.length).toBeGreaterThan(0);
      // Throttled — one row per (device, blockedBy) per 5 min, not one per tick.
      expect(blocked.length).toBeLessThan(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a batch whose commands are ALL deduped still journals and still refills the bucket", async () => {
    // The send-side dedupe returned early and silently when every command in a
    // batch was a duplicate: no journal row (the reduce decision carries no
    // `blockedBy`, which is all `journalBlocked` writes), and none of the
    // bookkeeping the pass owed. So the leaky bucket stayed empty, the urgent
    // trigger re-fired on every reading, and the only forensic surface there is
    // showed a hole. FLOORS re-assertion is the natural way to reproduce it: it
    // re-emits the same floor command every evaluation by design.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-03T06:15:00Z"));
      const mock = createGradePool();
      const controller = new LevelingControllerV2(mock.pool, {
        ...createDeps(),
        getTclCloud: () =>
          // Firmware that ignores the level, so the clamp keeps being re-emitted.
          ({ sendControl: async () => undefined, executeAcAction: async () => undefined }) as never,
      });
      await controller.ensureLoaded();
      const ctx = [
        { device: acDevice("a", true, 3), managed: true, needTier: "full" as const, needDelta: 2, slotGenCap: null, slotKey: null },
      ];
      let flip = 1;
      for (let i = 0; i < 6; i++) {
        flip = -flip;
        controller.onPowerReading({ current_1: 0, current_2: 8 + 0.01 * flip } as never);
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctx, 30);
      }
      const deduped = mock.journal.filter((r) =>
        JSON.stringify(r.decisions ?? []).includes("duplicate send"),
      );
      expect(deduped.length, "a fully-deduped batch left no trace at all").toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a shed room already ON at boot is not un-shed on the first stale shadow", async () => {
    // 2026-08-02's fix cleared the record on FIRST sight, from the boot shadow —
    // which lags 5.8s to 13min. A room shed just before a redeploy still reads
    // ON, and clearing then destroys the record of a room that is physically
    // off: the restore is lost and the model starts charging the meter for a
    // compressor that is not running.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-03T06:00:00Z"));
      const mock = createGradePool({}, ["a"]);
      const controller = new LevelingControllerV2(mock.pool, {
        ...createDeps(),
        getTclCloud: () =>
          ({ sendControl: async () => undefined, executeAcAction: async () => undefined }) as never,
      });
      await controller.ensureLoaded();
      const ctx = [
        { device: acDevice("a", true, 1), managed: true, needTier: "full" as const, needDelta: 2, slotGenCap: null, slotKey: null },
      ];
      controller.onPowerReading({ current_1: 0, current_2: 8 } as never);
      await controller.tick(ctx, 30);
      expect(controller.isShed("a"), "cleared on the very first boot sighting").toBe(true);
      // …but a room that is STILL on a minute and a half later really is on.
      for (let i = 0; i < 24; i++) {
        vi.advanceTimersByTime(5_000);
        controller.onPowerReading({ current_1: 0, current_2: 8 + 0.01 * (i % 2) } as never);
        await controller.tick(ctx, 30);
      }
      expect(controller.isShed("a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Shed-until-confirm + off-drop learning (2026-07-27 evening). Two halves of
// the same incident: (1) clearing the shed flag at power_on SEND opened a
// shadow-lag window in which the collector saw an un-shed device still OFF and
// minted a bogus manual-off lock 5.8s after the restore command; (2) a lone
// shed's instantaneous meter drop is the cleanest on-cost sample there is —
// without it, the wrong-low on@L1 that caused the bounce loop could never
// self-correct (turn-on grades need the full ramp window and were always
// contaminated or cut short by the bounce itself).
// ---------------------------------------------------------------------------

describe("LevelingControllerV2 — shed clears on confirmed ON, not at command send", () => {
  it("keeps the shed flag through the shadow lag, re-sends past the confirm window, clears on the flip", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-27T17:15:00Z"));
      const mock = createGradePool({}, ["b"]);
      const b = { id: "b", name: "b", power: false, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const powerOns: string[] = [];
      const deps: LevelingDeps = {
        ...createDeps(),
        getTclCloud: () =>
          ({
            sendControl: async () => undefined,
            // The cloud accepts the ON but the TCL shadow lags — b.power stays
            // false until the test flips it (5.8s–13 min observed live).
            executeAcAction: async (deviceId: string, action: { power?: number }) => {
              if (action.power === 1) powerOns.push(deviceId);
            },
          }) as never,
      };
      const controller = new LevelingControllerV2(mock.pool, deps);
      await controller.ensureLoaded();
      const ctx = [
        { device: acDevice("a", true, 1), managed: true, needTier: "full" as const, needDelta: 0.3, slotGenCap: null, slotKey: null },
        { device: b as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
      ];
      let flip = 1;
      const run = async (genAmps: number, steps: number) => {
        for (let i = 0; i < steps; i++) {
          flip = -flip;
          controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
          vi.advanceTimersByTime(5_000);
          await controller.tick(ctx, 30);
        }
      };

      await run(8, 8); // calm builds → the restore ships
      expect(powerOns).toEqual(["b"]);
      // The shadow still reads OFF — the shed flag MUST survive (it is what
      // keeps every observed-off lock recorder and auto-on path skipping b).
      expect(controller.isShed("b")).toBe(true);

      await run(8, 5); // 25s later: inside the confirm window — no re-send
      expect(powerOns).toEqual(["b"]);
      expect(controller.isShed("b")).toBe(true);

      await run(8, 9); // past the 60s confirm window — confirm-or-resend fires
      expect(powerOns.length).toBeGreaterThanOrEqual(2);
      expect(controller.isShed("b")).toBe(true);

      b.power = true; // the shadow finally confirms
      await run(8, 2);
      expect(controller.isShed("b")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Ramp-honest cost learning (2026-07-28). A level raise was graded 45s after
// the command (GRADE_LEVEL_MS) while the compressor needs AC_RAMP_MS (4 min) to
// reach its new steady draw, so every sample measured the first fifth of the
// ramp. Live 24h: 32 of 33 graded gen raises came in BELOW what admission
// charged (median −1.12A; Najat's L1→L2 graded +0.23A and the gen was shedding
// her 3.6 min later), and the cost book showed MORE samples giving LOWER costs
// — a biased estimator, not a converging one. max(model, learned) masked it, so
// the learned model was simply inert for raises.
// ---------------------------------------------------------------------------

describe("LevelingControllerV2 — a raise is learned over the whole compressor ramp", () => {
  it("learns the settled rise, not the slice of ramp visible at the journal grade", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-28T04:14:00Z"));
      const mock = createGradePool();
      // Ceiling L2, so the raise under test is the ONLY one — a second raise
      // would be a load-adding batch and would (correctly) contaminate it.
      const device = { id: "a", name: "a", power: true, generatorMode: 1, maxGeneratorLevel: 2, fanSpeed: 1 };
      const deps: LevelingDeps = {
        ...createDeps(),
        getTclCloud: () =>
          ({
            sendControl: async (_id: string, cmd: string, value: number) => {
              if (cmd === "set_generator_mode") device.generatorMode = value;
            },
            executeAcAction: async () => undefined,
          }) as never,
      };
      const controller = new LevelingControllerV2(mock.pool, deps);
      await controller.ensureLoaded();
      const ctx = [
        { device: device as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
      ];
      let flip = 1;
      const run = async (genAmps: number, steps: number) => {
        for (let i = 0; i < steps; i++) {
          flip = -flip;
          controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
          vi.advanceTimersByTime(5_000);
          await controller.tick(ctx, 30);
        }
      };

      await run(8, 8); // calm ≥ raiseCalmSeconds → the raise ships
      expect(device.generatorMode).toBe(2);
      // The compressor has barely begun: this is all the old 45s window saw.
      await run(8.3, 10);
      // …then it settles at its real draw, well inside the 4-min ramp.
      await run(11, 50);

      const learned = mock.costs.filter((c) => c.deviceId === "a" && c.transition === "level:1>2");
      expect(learned.length).toBeGreaterThan(0);
      // 11.0 − 8.0 = 3.0A of real cost. The 45s slice was ~0.3A — the value
      // that used to be folded into the EWMA, dragging the price DOWN with
      // every raise until admission was running on the config model alone.
      expect(learned[learned.length - 1].ewma).toBeGreaterThan(2.5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a mid-window REDUCTION does not under-read the raise (ratcheted peak)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-28T04:14:00Z"));
      const mock = createGradePool();
      const device = { id: "a", name: "a", power: true, generatorMode: 1, maxGeneratorLevel: 2, fanSpeed: 1 };
      const deps: LevelingDeps = {
        ...createDeps(),
        getTclCloud: () =>
          ({
            sendControl: async (_id: string, cmd: string, value: number) => {
              if (cmd === "set_generator_mode") device.generatorMode = value;
            },
            executeAcAction: async () => undefined,
          }) as never,
      };
      const controller = new LevelingControllerV2(mock.pool, deps);
      await controller.ensureLoaded();
      const ctx = [
        { device: device as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
      ];
      let flip = 1;
      const run = async (genAmps: number, steps: number) => {
        for (let i = 0; i < steps; i++) {
          flip = -flip;
          controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
          vi.advanceTimersByTime(5_000);
          await controller.tick(ctx, 30);
        }
      };

      await run(8, 8);
      expect(device.generatorMode).toBe(2);
      await run(11, 20); // the raise arrives in full: peak = +3.0A
      await run(8.5, 40); // a non-AC load leaves; the window closes low
      const learned = mock.costs.filter((c) => c.deviceId === "a" && c.transition === "level:1>2");
      expect(learned.length).toBeGreaterThan(0);
      // A plain end-of-window delta would read ~0.5A here. The ratchet keeps
      // the proven peak: absorption is a one-way fact.
      expect(learned[learned.length - 1].ewma).toBeGreaterThan(2.5);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Contamination is direction-aware so a full-ramp window is affordable: on a
// busy gen evening batches land every 30–60s, and marking every one of them a
// contaminant would mean nothing is ever learned. A batch that only REMOVES
// load cannot inflate a raise's ratcheted peak; one that only ADDS load cannot
// deepen a shed's trough.
describe("batchLoadDirections", () => {
  const at = (id: string) => (id === "known" ? 2 : null);

  it("classifies each command kind", () => {
    expect(batchLoadDirections([{ deviceId: "x", kind: "power_on", level: 1, reason: "restore" }], at))
      .toEqual({ adds: true, removes: false });
    expect(batchLoadDirections([{ deviceId: "x", kind: "power_off", reason: "shed" }], at))
      .toEqual({ adds: false, removes: true });
    expect(batchLoadDirections([{ deviceId: "known", kind: "set_level", level: 3 }], at))
      .toEqual({ adds: true, removes: false });
    expect(batchLoadDirections([{ deviceId: "known", kind: "set_level", level: 1 }], at))
      .toEqual({ adds: false, removes: true });
    expect(batchLoadDirections([{ deviceId: "x", kind: "set_fan", fan: 1, reason: "trim" }], at))
      .toEqual({ adds: false, removes: true });
    expect(batchLoadDirections([{ deviceId: "x", kind: "set_fan", fan: 3, reason: "trim_restore" }], at))
      .toEqual({ adds: true, removes: false });
  });

  it("a set_level with no confirmed level counts BOTH ways (trip-safe)", () => {
    expect(batchLoadDirections([{ deviceId: "unknown", kind: "set_level", level: 2 }], at))
      .toEqual({ adds: true, removes: true });
  });

  it("a level held at its current value moves nothing", () => {
    expect(batchLoadDirections([{ deviceId: "known", kind: "set_level", level: 2 }], at))
      .toEqual({ adds: false, removes: false });
  });

  it("a mixed batch contaminates both directions", () => {
    expect(
      batchLoadDirections(
        [
          { deviceId: "known", kind: "set_level", level: 3 },
          { deviceId: "y", kind: "power_off", reason: "shed" },
        ],
        at,
      ),
    ).toEqual({ adds: true, removes: true });
  });
});

describe("LevelingControllerV2 — a lone shed's off-drop grades the on-cost", () => {
  it("learns on@L{level} from the negated drop (a wrong-low cost self-corrects after ONE bounce)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-27T16:43:00Z"));
      const mock = createGradePool();
      const a = { id: "a", name: "a", power: true, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const deps: LevelingDeps = {
        ...createDeps(),
        getTclCloud: () =>
          ({
            sendControl: async () => undefined,
            executeAcAction: async (_id: string, action: { power?: number }) => {
              if (action.power === 0) a.power = false;
            },
          }) as never,
      };
      const controller = new LevelingControllerV2(mock.pool, deps);
      await controller.ensureLoaded();
      // needDelta under the near-target band → no raises interfere.
      const ctx = [{ device: a as never, managed: true, needTier: "full" as const, needDelta: 0.3, slotGenCap: null, slotKey: null }];
      let flip = 1;
      const run = async (genAmps: number, steps: number) => {
        for (let i = 0; i < steps; i++) {
          flip = -flip;
          controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
          vi.advanceTimersByTime(5_000);
          await controller.tick(ctx, 30);
        }
      };

      // Settle close under the limit, not far below it: the off-drop is
      // measured from `preAmps`, the SMOOTHED meter as the shed goes out, and
      // at SMOOTH_WINDOW 8 (2026-08-05) that median still carries most of the
      // settle level two readings into the breach. Settling at 10 made the
      // baseline read 10 against a 13.5A post-shed meter — a RISE, so the
      // window would learn nothing at all. At 14 the baseline reads 14 as the
      // bucket empties, which is the same figure the 4-wide window produced
      // from a 10A settle, so the sample under test is unchanged (0.5A).
      // Same trap the R6 evidence test above names in its own settle.
      await run(14, 8); // settle; recon confirms L1
      await run(18, 6); // hard over — the only cover is shedding a (single power_off)
      expect(a.power).toBe(false);
      // 13.5A after the off: the restore does not fit (13.5 + 2 > 14.9), so no
      // batch contaminates the off's grade window while it ripens (45s).
      await run(13.5, 14);

      const learned = mock.costs.find((c) => c.deviceId === "a" && c.transition === "on@L1");
      // Negated: the drop is a POSITIVE on-cost sample (the 0.2A learn gate
      // passed). Without the negate the delta is negative and nothing would
      // ever be learned from a shed — this row would not exist.
      expect(learned).toBeDefined();
      expect(learned!.ewma).toBeGreaterThan(0.2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LevelingControllerV2 — off-drop grade voided while a peer's drop still settles", () => {
  it("the second of two back-to-back sheds does not learn (its drop absorbs the first's wind-down)", async () => {
    // 2026-08-02 11:20: Abdu's L2→L1 cut and Najat's shed landed 5s apart.
    // Najat's off-drop window then measured −4.03A against a −2.3A truth — the
    // remainder was the peer's fall still landing through the median — and
    // booked it into on@L1. That inflated price later refused restores the
    // meter had real room for (17 min stranded, user rescue). A single-command
    // window born while an earlier load-DROP is still settling must journal
    // but never learn.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-02T08:20:00Z"));
      const mock = createGradePool({
        ampModels: { a: { baseAmps: 2, stepAmps: 2 }, b: { baseAmps: 2, stepAmps: 2 } },
      });
      const a = { id: "a", name: "a", power: true, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const b = { id: "b", name: "b", power: true, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const deps: LevelingDeps = {
        ...createDeps(),
        getTclCloud: () =>
          ({
            sendControl: async () => undefined,
            executeAcAction: async (id: string, action: { power?: number }) => {
              if (action.power === 0) (id === "a" ? a : b).power = false;
            },
          }) as never,
      };
      const controller = new LevelingControllerV2(mock.pool, deps);
      await controller.ensureLoaded();
      // needDelta under the near-target band → no raises interfere.
      const ctx = [
        { device: a as never, managed: true, needTier: "full" as const, needDelta: 0.3, slotGenCap: null, slotKey: null },
        { device: b as never, managed: true, needTier: "full" as const, needDelta: 0.3, slotGenCap: null, slotKey: null },
      ];
      let flip = 1;
      const run = async (genAmps: number, steps: number) => {
        for (let i = 0; i < steps; i++) {
          flip = -flip;
          controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
          vi.advanceTimersByTime(5_000);
          await controller.tick(ctx, 30);
        }
      };

      await run(10, 8); // settle; recon confirms both at L1
      // Mild over: required ≈ 0.5A < one shed's 2A savings, so the reducer
      // sheds ONE room (b — equal need, lower priority), not both in a batch.
      await run(15.4, 6);
      expect([a.power, b.power].filter((p) => !p)).toHaveLength(1);
      // The commanded fall lands (credit absorbed, bucket refills on calm),
      // then a fresh over-episode sheds the second room ~50s after the first —
      // INSIDE the first drop's settle window, so its off-drop sample cannot
      // be attributed to this batch alone.
      await run(13.4, 7);
      await run(16.6, 4);
      expect(a.power).toBe(false);
      expect(b.power).toBe(false);
      // Honest post-drop meter; run the grade windows out.
      await run(14.6, 20);

      // The FIRST shed was isolated — its honest off-drop must still learn
      // (the fix must not suppress clean samples). The SECOND was born inside
      // the first drop's settle window: journaled, never learned.
      expect(mock.costs.some((c) => c.deviceId === "b" && c.transition === "on@L1")).toBe(true);
      expect(mock.costs.filter((c) => c.deviceId === "a" && c.transition.startsWith("on@"))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Ramp-absorption ratchet (2026-07-27). `rampDebitAmps` credits a ramping AC
// with what the meter has risen since its compressor started — a whole-house
// delta, so any load that LEAVES afterwards masks it. Live: the reducer cut
// ~2.5A off two peers mid-ramp, the house landed below the ramping room's
// baseline, the credit clamped to 0 and it was re-charged its whole draw for
// the rest of its 240s window, fencing a fan restore for 2 extra minutes.
// ---------------------------------------------------------------------------

describe("LevelingControllerV2 — ramp absorption ratchet", () => {
  it("keeps the absorption credit when a peer's load leaves after the ramp armed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-27T13:47:00Z"));
      // Resting ceiling 15 − 0.1 − 0.2 = 14.7. b's modeled floor draw is 4.3A;
      // a's L1→L2 step costs 1.0A. Sized so the ONLY thing that decides the
      // raise is whether b's absorption survives the drop.
      const mock = createGradePool({
        ampModels: { a: { baseAmps: 2, stepAmps: 1 }, b: { baseAmps: 4.3, stepAmps: 2.5 } },
      });
      const sent: Array<{ deviceId: string; cmd: string; value: number }> = [];
      const deps: LevelingDeps = {
        ...createDeps(),
        getTclCloud: () =>
          ({
            sendControl: async (deviceId: string, cmd: string, value: number) => {
              sent.push({ deviceId, cmd, value });
            },
            executeAcAction: async () => undefined,
          }) as never,
      };
      const controller = new LevelingControllerV2(mock.pool, deps);
      await controller.ensureLoaded();

      // "a" is running; "b" is off and will turn on (arming its ramp).
      const b = { id: "b", name: "b", power: false, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const ctx = [
        { device: acDevice("a", true, 1), managed: true, needTier: "full" as const, needDelta: 2, slotGenCap: null, slotKey: null },
        { device: b as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
      ];
      let flip = 1;
      const run = async (genAmps: number, steps: number) => {
        for (let i = 0; i < steps; i++) {
          flip = -flip;
          controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
          vi.advanceTimersByTime(5_000);
          await controller.tick(ctx, 30);
        }
      };

      await run(10.0, 6); // settle: house ≈ 10.0A — a's step does not fit yet
      b.power = true; // off→on: tick() arms b's ramp against ~10.0A
      await run(10.0, 1);
      await run(12.0, 6); // b's compressor arrives — 2.0A of it is on the meter

      // Now a peer's load leaves (the live shape: the reducer's cuts), dropping
      // the house BELOW b's ramp baseline, so the instantaneous rise is negative.
      // Headroom 14.7 − 9.6 = 5.1A. Charged b's WHOLE 4.3A it leaves 0.8A and a's
      // step is refused for the rest of b's 240s window; crediting the 2.0A the
      // meter already proved arrived leaves 2.8A and the step ships.
      sent.length = 0;
      await run(9.6, 10);

      expect(sent).toContainEqual({ deviceId: "a", cmd: "set_generator_mode", value: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The fan calm clock survives a fan-only spend at the SHELL (2026-08-09, the
// 16:22Z gen cycle #11098-#11126). controller.ts rewinds BOTH calm anchors for a
// non-fan batch and only the MAIN anchor for a fan-only SPEND. scenario.ts
// MIRRORS this line — so a harness test cannot prove the real shell does it; the
// guard belongs here. A fan restore that lands must leave the main calm clock
// reset (a raise 12s later still waits — invariant 18) and the fan clock intact.
// ---------------------------------------------------------------------------

describe("LevelingControllerV2 — a fan-only restore spend spares the fan calm clock", () => {
  it("resets the main calm anchor but not the fan one when a gentle restore lands", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-09T16:22:00Z"));
      const mock = createMockPool();
      mock.configById.set(2, {
        controller: "v2",
        enabled: true,
        genLimitAmps: 15,
        marginAmps: 0.1,
        fanTrimEnabled: true,
        genAmpModels: { a: { baseAmps: 2, stepAmps: 2 } },
      });
      // A gentle fan hold pinned to 1 on a past restore — it climbs back to auto
      // once the line is calm, as a FAN-ONLY spend.
      mock.fanHolds.set("a", { original_fan: 0, last_set_fan: 1 });
      const controller = new LevelingControllerV2(mock.pool, {
        ...createDeps(),
        getTclCloud: () =>
          ({ sendControl: async () => undefined, executeAcAction: async () => undefined }) as never,
      });
      await controller.ensureLoaded();
      expect(controller.hasFanHold("a")).toBe(true);

      const ctx = [
        { device: acDevice("a", true, 1), managed: true, needTier: "mild" as const, needDelta: 0, slotGenCap: null, slotKey: null },
      ];
      const meterState = () =>
        (controller as unknown as { meterState: { calmSince: number | null; fanCalmSince: number | null } }).meterState;

      // Drive a long, roomy, calm gen line (6A against a 15A limit) past FLOORS
      // until the held fan climbs home and releases — that landing tick is the
      // fan-only spend whose calm-reset we are pinning.
      let flip = 1;
      let restored = false;
      for (let i = 0; i < 240 && !restored; i++) {
        flip = -flip;
        controller.onPowerReading({ current_1: 0, current_2: 6 + 0.01 * flip } as never);
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctx, 30);
        if (!controller.hasFanHold("a")) restored = true;
      }
      expect(restored, "the gentle fan hold climbed home within the window").toBe(true);

      // The landing tick's `resetCalm({ fanSpend: true })` fired: the MAIN clock
      // is reset (a raise still owes its calm — invariant 18)…
      expect(meterState().calmSince).toBeNull();
      // …but the fan path's own clock is spared, so a peer fan hold's first gear
      // would not be queued behind this spend.
      expect(meterState().fanCalmSince).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The 2026-07-30 gen turn-on (live 05:51:07 Baghdad, 15A gen). Najat had been
// driven to L3 by the grid full start, switched off, and came back on 33
// minutes into a gen session — long past FLOORS. The TCL restored
// generatorMode 3 and nothing admitted her: the house rode 16.77A and the user
// hand-set both rooms to L1 two minutes later.
//
// These are SHELL tests on purpose. scenario.ts mirrors this block, and the
// mirror is what failed us — it priced a turn-on at the level the AC was really
// at while the shell priced it at floorOf(), so no harness test could ever
// disagree with the shell. Both sides need their own guard.
// ---------------------------------------------------------------------------

describe("LevelingControllerV2 — a gen turn-on enters at its floor", () => {
  const genCfg = {
    genLimitAmps: 15,
    marginAmps: 0.1,
    genAmpModels: {
      abdu: { baseAmps: 4.3, stepAmps: 2.5 },
      abdullah: { baseAmps: 2.3, stepAmps: 2 },
      najat: { baseAmps: 2.3, stepAmps: 2 },
    },
  };

  type MockDevice = { id: string; name: string; power: boolean; generatorMode: number; maxGeneratorLevel: number; fanSpeed: number };
  const dev = (id: string, power: boolean, generatorMode: number): MockDevice => ({
    id,
    name: id,
    power,
    generatorMode,
    maxGeneratorLevel: 3,
    fanSpeed: 1,
  });

  /**
   * `confirmLevels: false` models Najat's firmware — the send is accepted and
   * the shadow keeps reporting the old level for anywhere from 5.8s to 13 min.
   */
  function setup(
    opts: { confirmLevels?: boolean; book?: Record<string, { ewmaAmps: number; samples: number; updatedAt: number }> } = {},
  ) {
    const mock = createGradePool(genCfg, [], opts.book ?? {});
    const sent: Array<{ deviceId: string; level: number }> = [];
    const abdullah = dev("abdullah", true, 3);
    const abdu = dev("abdu", true, 1);
    const najat = dev("najat", false, 3); // off, holding the grid full start's L3
    const deps: LevelingDeps = {
      ...createDeps(),
      getTclCloud: () =>
        ({
          sendControl: async (id: string, cmd: string, value: number) => {
            if (cmd !== "set_generator_mode") return;
            sent.push({ deviceId: id, level: value });
            if (opts.confirmLevels !== false) {
              for (const d of [abdullah, abdu, najat]) if (d.id === id) d.generatorMode = value;
            }
          },
          executeAcAction: async () => undefined,
        }) as never,
    };
    const controller = new LevelingControllerV2(mock.pool, deps);
    const ctx = [
      { device: abdullah, managed: true, needTier: "full", needDelta: 1.5, slotGenCap: null, slotKey: null },
      { device: abdu, managed: true, needTier: "full", needDelta: 1.6, slotGenCap: null, slotKey: null },
      { device: najat, managed: true, needTier: "mild", needDelta: 0.9, slotGenCap: null, slotKey: null },
    ];
    let flip = 1;
    const run = async (amps: number, steps: number, line: "gen" | "grid" = "gen") => {
      for (let i = 0; i < steps; i++) {
        flip = -flip;
        const jitter = amps + 0.01 * flip;
        controller.onPowerReading(
          (line === "gen" ? { current_1: 0, current_2: jitter } : { current_1: jitter, current_2: 0 }) as never,
        );
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctx as never, 30);
      }
    };
    return { mock, controller, najat, sent, run };
  }

  /** Past FLOORS_MAX_MS — the live turn-on was 33 minutes into the session. */
  const SETTLED_STEPS = 80; // 400s

  it("clamps her to L1 — the level the firmware restored is not an admission", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-30T02:51:00Z"));
      const { mock, controller, najat, sent, run } = setup();
      await controller.ensureLoaded();

      await run(13.2, SETTLED_STEPS);
      sent.length = 0;
      const before = mock.journal.length;
      najat.power = true; // the user turns her on; the TCL restores L3
      await run(13.2, 4);

      expect(sent.some((c) => c.deviceId === "najat" && c.level === 1)).toBe(true);
      expect(
        mock.journal.slice(before).some((r) => String(r.decisions).includes("gen start L1")),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sizes the over-limit deficit off the L3 she is really at, not her floor", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-30T02:51:00Z"));
      const { mock, controller, najat, run } = setup();
      await controller.ensureLoaded();

      await run(13.2, SETTLED_STEPS);
      const before = mock.journal.length;
      najat.power = true;
      await run(13.2, 3);

      const over = mock.journal.slice(before).filter((r) => String(r.reason).startsWith("over"));
      expect(over.length).toBeGreaterThan(0);
      // Live it asked for 1.2A: 13.205 + her on@L1 (2.86A) − 15 + 0.1. Her real
      // L3 steady draw is 6.3A on this model, so the honest ask is ~4.6A — more
      // than cutting her alone covers, which is the whole point.
      expect(Number(over[0].requiredAmps)).toBeGreaterThan(3.5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps pricing L3 while the clamp is in flight (shadow lag is not agreement)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-30T02:51:00Z"));
      const { mock, controller, najat, run } = setup({ confirmLevels: false });
      await controller.ensureLoaded();

      await run(13.2, SETTLED_STEPS);
      najat.power = true;
      await run(13.2, 3);
      const afterFirst = mock.journal.length;
      // The clamp went out but her shadow still reads 3. A command in flight is
      // not an observation — the projection must keep charging what the
      // compressor could still be drawing. (Past the 30s settle window, or every
      // tick reads "settling" and proves nothing.)
      await run(13.2, 12);
      const over = mock.journal.slice(afterFirst).filter((r) => String(r.reason).startsWith("over"));
      expect(over.length).toBeGreaterThan(0);
      expect(Number(over[0].requiredAmps)).toBeGreaterThan(1.5);
    } finally {
      vi.useRealTimers();
    }
  });

  // Live 12:42:32 the same day — the THIRD gen trip. Najat came on at L1 (the
  // leveler's 11:44 restore had left her there), so the L3 clamp was irrelevant;
  // what mattered was the price. The projection charged her modeled 2.3A while
  // her learned on@L1 was 2.86A and the meter delivered 2.9A, so it asked for
  // 0.5A instead of 1.0A. The bare model draw is the PROBE price and belongs
  // only to a restore we admitted at that price.
  it("prices a user turn-on at the LEARNED on-cost, not the bare model draw", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-30T09:42:00Z"));
      const { mock, controller, najat, run } = setup({
        book: { "najat|gen|on@L1": { ewmaAmps: 2.86, samples: 15, updatedAt: Date.now() } },
      });
      await controller.ensureLoaded();

      await run(13.075, SETTLED_STEPS);
      najat.generatorMode = 1; // she comes back at her floor this time
      const before = mock.journal.length;
      najat.power = true;
      await run(13.075, 3);

      // Assert the SIZING, not what the reducer chose to do with it — with
      // nothing cheap left to cut the batch journals as `blocked`, and the
      // deficit it was sized against is still on the row.
      const sized = mock.journal.slice(before).filter((r) => r.requiredAmps != null);
      expect(sized.length).toBeGreaterThan(0);
      // model 2.3 → 13.075 + 2.3 − 15 + 0.1 = 0.5 (what live asked for).
      // learned 2.86 → 13.075 + 2.86 − 15 + 0.1 = 1.0.
      expect(Number(sized[0].requiredAmps)).toBeGreaterThan(0.8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clamp on grid — there the start window lifts instead", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-30T02:51:00Z"));
      const { controller, najat, sent, run } = setup();
      await controller.ensureLoaded();

      await run(13.2, SETTLED_STEPS, "grid");
      sent.length = 0;
      najat.power = true;
      await run(13.2, 4, "grid");

      expect(sent.filter((c) => c.deviceId === "najat" && c.level === 1)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-08-01 (live 17:27 Baghdad, 15A gen). Abdullah's AC turned off, and the
// tick after read the smoothed meter — still carrying his dying compressor —
// against a modeled side he had already left: 7.1A of "house" (real: ~4.1A).
// The only sample tagged with the new running set, so it WAS the 15-minute
// peak: every raise refused at "worst case 16.2A > 14.9A" while the meter sat
// at 11–12A, until the user raised Abdu to L2 by hand. SHELL test on purpose —
// scenario.ts mirrors the sampling call, and both sides need their own guard.
// ---------------------------------------------------------------------------

describe("LevelingControllerV2 — a turn-off's decay is not house", () => {
  it("spends the freed headroom on the hot room instead of fencing it behind the ghost", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-01T14:20:00Z"));
      const mock = createGradePool({
        genAmpModels: {
          abdullah: { baseAmps: 2.3, stepAmps: 2.5 },
          najat: { baseAmps: 2.3, stepAmps: 2.0 },
          abdu: { baseAmps: 4.3, stepAmps: 2.5 },
        },
      });
      const sent: Array<{ deviceId: string; cmd: string; value: number }> = [];
      const deps: LevelingDeps = {
        ...createDeps(),
        getTclCloud: () =>
          ({
            sendControl: async (deviceId: string, cmd: string, value: number) => {
              sent.push({ deviceId, cmd, value });
            },
            executeAcAction: async () => undefined,
          }) as never,
      };
      const controller = new LevelingControllerV2(mock.pool, deps);
      await controller.ensureLoaded();

      const abdullah = { id: "abdullah", name: "abdullah", power: true, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const ctx = [
        { device: abdullah as never, managed: true, needTier: "mild" as const, needDelta: 0.6, slotGenCap: null, slotKey: null },
        { device: acDevice("najat", true, 1), managed: true, needTier: "mild" as const, needDelta: 0.5, slotGenCap: null, slotKey: null },
        { device: acDevice("abdu", true, 1), managed: true, needTier: "full" as const, needDelta: 2.4, slotGenCap: null, slotKey: null },
      ];
      let flip = 1;
      const run = async (genAmps: number, steps: number) => {
        for (let i = 0; i < steps; i++) {
          flip = -flip;
          controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
          vi.advanceTimersByTime(5_000);
          await controller.tick(ctx, 30);
        }
      };

      // 6 min settled at 13.2A with all three at L1 (modeled 8.9 → honest house
      // ≈ 4.3A). Nothing fits: any step puts the meter past 14.7.
      await run(13.2, 72);
      expect(sent.filter((c) => c.cmd === "set_generator_mode")).toHaveLength(0);

      // The user turns Abdullah's room off. The first tick still smooths 13.2A
      // against a modeled side of 6.6 — the contaminated moment.
      abdullah.power = false;
      await run(13.2, 1);
      sent.length = 0;

      // The meter settles at 10.7A: 2.5A of true headroom for Abdu's step, and
      // the envelope sees an honest house (carried 4.3 → measured 4.1) — not
      // the departed room's 6.6A ghost.
      await run(10.7, 48);
      expect(sent).toContainEqual({ deviceId: "abdu", cmd: "set_generator_mode", value: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The changeover dead window (2026-08-04, 11:16-11:23 Baghdad, 15A gen). The
// grid→gen changeover power-cycled all three ACs; TCL compressor restart
// protection then held every compressor off for ~6 minutes while the rooms drew
// about their fans. The 240s ramp windows expired ON THE CLOCK at 11:20:10 with
// nothing running, FLOORS cleared four seconds later (it waits for "nothing
// ramping"), and the raise path opened onto a 6.1A meter that was pure house:
// Abdullah L2→L3 at 11:20:14, Abdu L1→L2 at 11:20:49, both admitted against a
// house the freed sampler had just booked at 0.0A (`max(0, 6.1 − 10.4)`).
//
// SHELL tests on purpose. scenario.ts mirrors both halves of this — which ramp
// a power event opened, and the direct house sample at the call site — and the
// mirror is exactly what a one-sided change hides.
// ---------------------------------------------------------------------------

describe("LevelingControllerV2 — a ramp closes on evidence, not on its timer", () => {
  function setup() {
    const mock = createGradePool({
      genAmpModels: {
        abdullah: { baseAmps: 2.3, stepAmps: 2.5 },
        najat: { baseAmps: 2.3, stepAmps: 2.0 },
        abdu: { baseAmps: 4.3, stepAmps: 2.5 },
      },
    });
    const sent: Array<{ deviceId: string; value: number }> = [];
    const devices = [
      { id: "abdullah", name: "abdullah", power: true, generatorMode: 3, maxGeneratorLevel: 3, fanSpeed: 1 },
      { id: "najat", name: "najat", power: true, generatorMode: 3, maxGeneratorLevel: 3, fanSpeed: 1 },
      { id: "abdu", name: "abdu", power: true, generatorMode: 3, maxGeneratorLevel: 3, fanSpeed: 1 },
    ];
    const deps: LevelingDeps = {
      ...createDeps(),
      getTclCloud: () =>
        ({
          sendControl: async (id: string, cmd: string, value: number) => {
            if (cmd !== "set_generator_mode") return;
            sent.push({ deviceId: id, value });
            for (const d of devices) if (d.id === id) d.generatorMode = value;
          },
          executeAcAction: async () => undefined,
        }) as never,
    };
    const controller = new LevelingControllerV2(mock.pool, deps);
    const ctx = devices.map((device, i) => ({
      device: device as never,
      managed: true,
      needTier: "full" as const,
      needDelta: [3, 1, 2.5][i],
      slotGenCap: null,
      slotKey: null,
    }));
    let flip = 1;
    const run = async (amps: number, steps: number, line: "gen" | "grid") => {
      for (let i = 0; i < steps; i++) {
        flip = -flip;
        const jitter = amps + 0.01 * flip;
        controller.onPowerReading(
          (line === "gen" ? { current_1: 0, current_2: jitter } : { current_1: jitter, current_2: 0 }) as never,
        );
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctx as never, 30);
      }
    };
    return { mock, controller, sent, run };
  }

  /** Longer than AC_RAMP_MS (240s) — the live dead window ran ~6-7 minutes. */
  const DEAD_STEPS = 84; // 420s

  it("refuses to spend for the whole dead window, and still lands the gen floors", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T08:10:00Z"));
      const { controller, sent, run } = setup();
      await controller.ensureLoaded();

      await run(15.5, 60, "grid"); // a settled grid session, everyone at L3
      sent.length = 0;
      // 11:16:10 — the changeover. Every compressor power-cycles, and the line
      // carries the house alone: 2.0A against an 8.9A model once the floors land.
      await run(2.0, DEAD_STEPS, "gen");

      // Entry policy is NOT a spend and must still ship (FLOORS).
      expect(sent.filter((c) => c.value === 1).map((c) => c.deviceId).sort()).toEqual(
        expect.arrayContaining(["abdu", "najat"]),
      );
      // …and nothing at all climbs while no compressor has started. Live, two
      // raises were admitted four seconds after the ramp windows expired.
      const raises = sent.filter((c) => c.value > 1);
      expect(raises, JSON.stringify(raises)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the raise path back once the meter shows a compressor", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T08:10:00Z"));
      const { controller, sent, run } = setup();
      await controller.ensureLoaded();

      await run(15.5, 60, "grid");
      await run(2.0, DEAD_STEPS, "gen");
      sent.length = 0;
      // The compressors finally engage: 8.9A of AC on top of the 2.0A house.
      // The hold has to release, or the fix is a freeze rather than a guard.
      await run(10.9, 90, "gen");

      expect(sent.filter((c) => c.value > 1).length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Trip on ENTRY (2026-08-04, user-confirmed breaker trip and manual reset).
// `ingestReading` judges FALLS inside a source session, so a gen session that
// BEGINS with the AC circuit dead has no cliff to latch on: the third real trip
// in ten days went unlatched, no derate armed, and the controller then rode
// 14.3–14.8A on a breaker that had just opened.
//
// SHELL tests on purpose. The evidence is device LIVENESS — `isOnline` and
// `lastSeenAt` off the TCL shadow, which the leveler had never read before and
// which scenario.ts can only mirror, not reproduce. Both sides need their own
// guard (the SKILL's mirror warning).
// ---------------------------------------------------------------------------

describe("LevelingControllerV2 — a session that begins with a dead circuit", () => {
  type LiveDevice = { id: string; isOnline: boolean; lastSeenAt: number | null };

  function setup() {
    const mock = createGradePool({
      genAmpModels: {
        abdullah: { baseAmps: 2.3, stepAmps: 2.5 },
        najat: { baseAmps: 2.3, stepAmps: 2.0 },
        abdu: { baseAmps: 4.3, stepAmps: 2.5 },
      },
    });
    const pushes: string[] = [];
    const sent: Array<{ deviceId: string; value: number }> = [];
    // At L3, as they are after a grid session — so the gen entry actually has
    // floors to clamp, which is what puts a send on the wire to go unanswered.
    const devices = ["abdullah", "najat", "abdu"].map(
      (id) => ({ ...(acDevice(id, true, 3) as object), isOnline: true, lastSeenAt: Date.now() }) as unknown as LiveDevice,
    );
    const deps: LevelingDeps = {
      ...createDeps(),
      broadcast: async (payload: Record<string, unknown>) => {
        pushes.push(String(payload.body));
      },
      getTclCloud: () =>
        ({
          sendControl: async (id: string, cmd: string, value: number) => {
            if (cmd === "set_generator_mode") sent.push({ deviceId: id, value });
          },
          executeAcAction: async () => undefined,
        }) as never,
    };
    const controller = new LevelingControllerV2(mock.pool, deps);
    const ctx = devices.map((device, i) => ({
      device: device as never,
      managed: true,
      needTier: "full" as const,
      needDelta: [3, 1, 2.5][i],
      slotGenCap: null,
      slotKey: null,
    }));
    let flip = 1;
    /** `dark` stops the shadows reporting — the AC circuit feeds the Wi-Fi modules. */
    const run = async (amps: number, steps: number, line: "gen" | "grid", dark = false) => {
      for (let i = 0; i < steps; i++) {
        flip = -flip;
        const jitter = amps + 0.01 * flip;
        if (!dark) for (const d of devices) d.lastSeenAt = Date.now();
        controller.onPowerReading(
          (line === "gen" ? { current_1: 0, current_2: jitter } : { current_1: jitter, current_2: 0 }) as never,
        );
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctx as never, 30);
      }
    };
    return { mock, controller, devices, pushes, sent, run };
  }

  /**
   * The modules ride the AC circuit, so the breaker opening is the last anyone
   * hears from them — well before the changeover the leveler anchors "since
   * entry" to.
   */
  const goDark = (devices: LiveDevice[]) => {
    for (const d of devices) d.lastSeenAt = Date.now() - 60_000;
  };
  /** Past ENTRY_COLLAPSE_UNCONFIRMED_MS (2 min) + ENTRY_COLLAPSE_DWELL_MS (60s). */
  const DEAD_STEPS = 72; // 360s

  it("latches the collapse, derates the line, and says so out loud", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T08:10:00Z"));
      const { mock, controller, pushes, sent, run } = setup();
      await controller.ensureLoaded();

      await run(13.0, 40, "grid");
      const before = mock.journal.length;
      sent.length = 0;
      // The changeover, and the AC breaker is already open: 5A of house on the
      // line against three rooms the model says are drawing 8.9A, and every
      // shadow dark because the modules lost power with the circuit.
      await run(5.0, DEAD_STEPS, "gen", true);

      expect(controller.getStatus().mode).toBe("COLLAPSED");
      // The REAL machinery, not a softer version of it: the ceiling comes down
      // while the breaker cools (invariants 2/15).
      expect(controller.getStatus().limitAmps).toBeLessThan(15);
      expect(pushes.some((p) => p.includes("AC circuit appears dead"))).toBe(true);
      expect(
        mock.journal.slice(before).some((r) => r.reason === "collapse_on_entry"),
      ).toBe(true);
      // Everything that DID go out before we knew was the gen-entry floor clamp
      // — a source-entry batch, which must keep shipping while the evidence is
      // still only suspicion. Nothing ever climbed.
      expect(sent.filter((c) => c.value !== 1)).toHaveLength(0);
      // …and once latched, the line gets nothing at all.
      const atLatch = sent.length;
      await run(5.0, 24, "gen", true);
      expect(sent.length).toBe(atLatch);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT latch while the rooms are merely slow to start", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T08:10:00Z"));
      const { controller, pushes, run } = setup();
      await controller.ensureLoaded();

      await run(13.0, 40, "grid");
      // Identical meter, identical gap — but restart protection keeps the Wi-Fi
      // modules powered, so the shadows keep reporting. That is the whole
      // discriminator between "no compressor has started" and "no circuit".
      await run(5.0, DEAD_STEPS, "gen");

      expect(controller.getStatus().mode).not.toBe("COLLAPSED");
      expect(controller.getStatus().limitAmps).toBe(15);
      expect(pushes.some((p) => p.includes("AC circuit appears dead"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("one room still reporting is a cloud problem, not a breaker", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T08:10:00Z"));
      const { controller, devices, run } = setup();
      await controller.ensureLoaded();

      await run(13.0, 40, "grid");
      // Two modules go quiet; the third keeps reporting throughout.
      const alive = devices[2];
      let flip = 1;
      for (let i = 0; i < DEAD_STEPS; i++) {
        flip = -flip;
        alive.lastSeenAt = Date.now();
        controller.onPowerReading({ current_1: 0, current_2: 5.0 + 0.01 * flip } as never);
        vi.advanceTimersByTime(5_000);
        await controller.tick(
          devices.map((device, i2) => ({
            device: device as never,
            managed: true,
            needTier: "full" as const,
            needDelta: [3, 1, 2.5][i2],
            slotGenCap: null,
            slotKey: null,
          })) as never,
          30,
        );
      }
      expect(controller.getStatus().mode).not.toBe("COLLAPSED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases on the rooms coming back, and re-enters at floors", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T08:10:00Z"));
      const { controller, devices, sent, run } = setup();
      await controller.ensureLoaded();

      await run(13.0, 40, "grid");
      goDark(devices);
      await run(5.0, DEAD_STEPS, "gen", true);
      expect(controller.getStatus().mode).toBe("COLLAPSED");
      sent.length = 0;
      // The user resets the breaker: the shadows report again and the rooms
      // draw. The latch is evidence-held, so it goes the moment the evidence
      // does — and the re-entry is FLOORS, like any other gen entry.
      await run(13.0, 12, "gen");

      expect(controller.getStatus().mode).not.toBe("COLLAPSED");
      expect(controller.getStatus().limitAmps).toBeLessThan(15); // still cooling
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// R14 LEARNED hold (user, 2026-08-04): "when the system observe that abdullah
// is not working on l1 (by own observation or manual raise), it should state
// the outside temp, so it will never reduce the level to l1 untill it drop
// below that temp or after [6] h".
//
// SHELL tests. The hold is armed by shell-owned evidence (the sub-floor watch
// clock, a manual raise arriving on its own HTTP request), keyed on the outdoor
// feed only the shell sees, and PERSISTED — none of which scenario.ts models.
// The pure release/merge arithmetic has its own guards in level-hold.test.ts.
// ---------------------------------------------------------------------------

describe("LevelingControllerV2 — the learned L1 non-cooling hold (R14)", () => {
  const HOT = "hot";
  const COOL = "cool";

  function setup(opts: {
    holds?: Map<string, { level: number; outdoorC: number; observedAt: number }>;
    hotLevel?: number;
    levelBoosts?: Record<string, { minLevel: number; outdoorAtLeastC: number }>;
    hotNeed?: number;
  } = {}) {
    const mock = createGradePool(
      {
        genLimitAmps: 15,
        priority: [HOT, COOL],
        genAmpModels: { [HOT]: { baseAmps: 2.3, stepAmps: 1.5 }, [COOL]: { baseAmps: 2.3, stepAmps: 1.5 } },
        ...(opts.levelBoosts != null ? { levelBoosts: opts.levelBoosts } : {}),
      },
      [],
      {},
      opts.holds ?? new Map(),
    );
    const sent: Array<{ deviceId: string; value: number }> = [];
    const offs: string[] = [];
    const deps: LevelingDeps = {
      ...createDeps(),
      getTclCloud: () =>
        ({
          sendControl: async (id: string, cmd: string, value: number) => {
            if (cmd === "set_generator_mode") sent.push({ deviceId: id, value });
          },
          executeAcAction: async (id: string, action: Record<string, unknown>) => {
            if (action.power === 0) offs.push(id);
          },
        }) as never,
    };
    const controller = new LevelingControllerV2(mock.pool, deps);
    const device = (id: string, level: number, temp: number) =>
      ({ ...(acDevice(id, true, level) as object), currentTemp: temp }) as never;
    // The hot room's SHADOW level, rebuilt per step so a test can make the
    // device report a level nobody commanded (`observeHotAt`) — which is exactly
    // what a TCL does when it power-cycles and restores its last level.
    let hotLevel = opts.hotLevel ?? 2;
    const ctxNow = () => [
      { device: device(HOT, hotLevel, 32), managed: true, needTier: "full" as const, needDelta: opts.hotNeed ?? 5, slotGenCap: null, slotKey: null },
      { device: device(COOL, 1, 27), managed: true, needTier: "full" as const, needDelta: 1, slotGenCap: null, slotKey: null },
    ];
    let flip = 1;
    // `gapMs` is the spacing between ESP readings: anything over
    // `ESP_GAP_EVENT_MS` (20s) makes the NEXT reading a power event.
    const run = async (amps: number, steps: number, outdoorC: number | null, gapMs = 5_000) => {
      for (let i = 0; i < steps; i++) {
        flip = -flip;
        controller.onPowerReading({ current_1: 0, current_2: amps + 0.01 * flip } as never);
        vi.advanceTimersByTime(gapMs);
        await controller.tick(ctxNow() as never, outdoorC);
      }
    };
    return { mock, controller, sent, offs, run, observeHotAt: (level: number) => void (hotLevel = level) };
  }

  it("a hold loaded from the DB governs the ladder immediately — a deploy does not erase it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T10:00:00Z"));
      // Observed an hour ago at 39°C outdoor; it is 44°C now, so it binds.
      const holds = new Map([[HOT, { level: 1, outdoorC: 39, observedAt: Date.now() - 3_600_000 }]]);
      const { controller, sent, offs, run } = setup({ holds });
      await controller.ensureLoaded();

      // The 13:10:47 shape: a projected mild overshoot with the coolest room
      // already at its floor, so the hottest room's L2→L1 is the only level rung
      // left on the board. That is the cut the user banned.
      await run(15.6, 14, 44);

      expect(controller.getStatus().acs.find((a) => a.deviceId === HOT)?.minLevel).toBe(2);
      expect(sent.filter((c) => c.deviceId === HOT && c.value === 1)).toHaveLength(0);
      // Something still had to give, and it is the coolest room — priced as an
      // off either way (invariants 36/39), so it goes where the user sends it.
      expect(offs.every((id) => id === COOL)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases when the weather goes back under the observation, and drops the row", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T10:00:00Z"));
      const holds = new Map([[HOT, { level: 1, outdoorC: 39, observedAt: Date.now() }]]);
      const { mock, controller, run } = setup({ holds });
      await controller.ensureLoaded();

      await run(12.0, 4, 44);
      expect(controller.getStatus().acs.find((a) => a.deviceId === HOT)?.levelHold?.outdoorC).toBe(39);
      // 38.4°C — past the observation by more than the release hysteresis.
      await run(12.0, 4, 38.4);
      expect(controller.getStatus().acs.find((a) => a.deviceId === HOT)?.levelHold ?? null).toBeNull();
      expect(controller.getStatus().acs.find((a) => a.deviceId === HOT)?.minLevel).toBe(1);
      expect(mock.levelHolds.has(HOT)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms from a MANUAL raise off L1 — the user in the room outranks any clock", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T10:00:00Z"));
      // A boost is CONFIGURED for HOT (FIX C, 2026-08-26): the learned hold only
      // refines the threshold of a DECLARED low-level failure. Its 50°C threshold
      // is dormant at 41°C, so it does not raise HOT off L1 on its own, and the
      // hand raise is still what arms the hold.
      const { mock, controller, run } = setup({
        hotLevel: 1,
        levelBoosts: { [HOT]: { minLevel: 2, outdoorAtLeastC: 50 } },
      });
      await controller.ensureLoaded();
      // Settle so the reconciler has a CONFIRMED L1 to raise off. Near the
      // limit on purpose: with headroom the leveler would buy the level itself
      // and there would be no hand raise to learn from.
      await run(14.6, 6, 41);

      await controller.onUserGenLevel(HOT, 2);
      await run(14.6, 1, 41);

      expect(mock.levelHolds.get(HOT)).toMatchObject({ level: 1, outdoorC: 41 });
      expect(controller.getStatus().acs.find((a) => a.deviceId === HOT)?.levelHold?.detail).toContain("41.0°C outdoor");
    } finally {
      vi.useRealTimers();
    }
  });

  it("REGRESSION 2026-08-06 02:15:29: a satisfied room stalled at L1 arms NOTHING", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T02:12:00Z"));
      // The live shape. 37°C is inside Abdullah's watch zone (39 − 3) and below
      // his configured floor, so the boost has not armed and the sub-floor watch
      // is running at L1 — which is where the old armer lived.
      //
      // The room was demoted to L1 at 02:12:20 FOR BEING SATISFIED for twenty
      // minutes (need 0.2, inside nearTargetBandC), and an at-target room can
      // never show the 0.2°C of further cooling that re-bases the watch. So the
      // watch was guaranteed to stall, and its verdict was true by construction
      // of the state that produced it. It armed a six-hour hold at 02:15:29,
      // re-armed at 02:35:21, and raised him L1→L2 at 02:36:42 — the 1.5–1.9A
      // that made restoring the hotter 4.3A room infeasible until 02:49.
      const { mock, controller, run } = setup({
        hotLevel: 1,
        hotNeed: 0.2,
        levelBoosts: { [HOT]: { minLevel: 2, outdoorAtLeastC: 39 } },
      });
      await controller.ensureLoaded();

      // Nearly four minutes — well past SUBFLOOR_WATCH_MS (3 min) — with the
      // need pinned, i.e. no cooling progress at all.
      await run(14.6, 45, 37);

      const status = controller.getStatus().acs.find((a) => a.deviceId === HOT);
      // No hold, no floor: amps are the only evidence now (user, 2026-08-06).
      expect(mock.levelHolds.size).toBe(0);
      expect(status?.levelHold ?? null).toBeNull();
      expect(status?.minLevel).toBe(1);
      expect(status?.level).toBe(1); // …so nothing raised him off L1 either
      // The clock itself is untouched and still REPORTED — it just decides
      // nothing. That is the whole of the change: an observation, not a verdict.
      expect(status?.subFloorStalledMs ?? 0).toBeGreaterThanOrEqual(SUBFLOOR_WATCH_MS);
      expect(status?.coolingState).toBe("stalled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("REGRESSION 2026-08-06 07:01:52: a level jump off L1 near a power event is firmware restore, not a human raise", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T06:44:00Z"));
      const { mock, controller, run, observeHotAt } = setup({ hotLevel: 1 });
      await controller.ensureLoaded();
      // Settle so the reconciler holds a CONFIRMED L1 to jump off, near the
      // limit so the leveler itself never buys that level — and run long enough
      // that the boot source-change (a power event in its own right) is well
      // outside the window. The BLINK below has to be the only thing explaining
      // the skip, or this test would pass with the guard reading any stale event.
      await run(14.6, 68, 43, 15_000);

      // The generator brownout-blinked: ESP gaps of 25s and 28s at 07:00:49 and
      // 07:01:23. The gap lands on the reading AFTER a long spacing, so the
      // first call opens the silence and the second is where it is detected.
      await run(14.6, 1, 43, 25_000);
      // …and 29 s later the device poll came back with a level nobody sent. A
      // TCL restores its last commanded level when it power-cycles, and in the
      // shadow that is indistinguishable from a hand on the remote.
      observeHotAt(2);
      await run(14.6, 1, 43);

      // Nobody touched the AC, so nothing was learned about L1. The bogus hold
      // put Abdu's restore floor at L2 (6.5A instead of 4.3A) and stranded the
      // hottest room off at 43°C outdoor.
      expect(mock.levelHolds.size).toBe(0);
      const status = controller.getStatus().acs.find((a) => a.deviceId === HOT);
      expect(status?.levelHold ?? null).toBeNull();
      expect(status?.minLevel).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still arms from the same jump when no power event is anywhere near it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T06:30:00Z"));
      // A boost is CONFIGURED for HOT (FIX C, 2026-08-26), dormant at 43°C (50°C
      // threshold), so it neither raises HOT itself nor blocks the observed hand
      // raise from arming the learned hold.
      const { mock, controller, run, observeHotAt } = setup({
        hotLevel: 1,
        levelBoosts: { [HOT]: { minLevel: 2, outdoorAtLeastC: 50 } },
      });
      await controller.ensureLoaded();
      // The FIRST reading is itself a power event (source none → gen), so the
      // control has to outlast the window: ~17 min of unbroken 15 s readings,
      // every one of them under the 20 s that would count as a gap.
      await run(14.6, 68, 43, 15_000);

      observeHotAt(2);
      await run(14.6, 1, 43, 15_000);

      // Same observation, no power event to explain it → somebody in the room
      // decided L1 was not doing anything, and R14 learns it exactly as before.
      expect(mock.levelHolds.get(HOT)).toMatchObject({ level: 1, outdoorC: 43 });
      expect(controller.getStatus().acs.find((a) => a.deviceId === HOT)?.minLevel).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records nothing when the outdoor feed is stale — a hold with no bar is a six-hour ban", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T10:00:00Z"));
      // Exercised through the MANUAL raise now that the watch no longer arms
      // anything: the guard belongs to `noteLevelHold`, so any armer proves it. A
      // boost is CONFIGURED for HOT (FIX C, 2026-08-26) so the raise reaches
      // `noteLevelHold` at all — it then declines because the outdoor feed is stale.
      const { mock, controller, run } = setup({
        hotLevel: 1,
        levelBoosts: { [HOT]: { minLevel: 2, outdoorAtLeastC: 50 } },
      });
      await controller.ensureLoaded();
      await run(14.6, 6, null);

      await controller.onUserGenLevel(HOT, 2);
      await run(14.6, 1, null);

      expect(mock.levelHolds.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // FIX C (2026-08-26): the hand-raise armers refine the outdoor threshold of a
  // room whose low-level failure the user DECLARED via a configured levelBoost.
  // For a boost-less room a hand raise off L1 is a comfort choice, not compressor
  // evidence: live 13:45Z a household member raised Najat (no boost) L1→3 with fan
  // 7 from the dashboard, and the old armer minted a false 6h min-L2 hold that
  // admitted her at L2 on the 14:02:49Z gen entry (journal #20044).
  // -------------------------------------------------------------------------
  it("FIX C: a hand raise off L1 arms the hold WHEN a level boost is configured", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-26T13:00:00Z"));
      // Boost configured but dormant at 41°C (50°C threshold), so it does not raise
      // HOT itself — the hand raise is what arms the learned hold.
      const { mock, controller, run } = setup({
        hotLevel: 1,
        levelBoosts: { [HOT]: { minLevel: 2, outdoorAtLeastC: 50 } },
      });
      await controller.ensureLoaded();
      await run(14.6, 6, 41);

      await controller.onUserGenLevel(HOT, 2);
      await run(14.6, 1, 41);

      expect(mock.levelHolds.get(HOT)).toMatchObject({ level: 1, outdoorC: 41 });
      expect(controller.getStatus().acs.find((a) => a.deviceId === HOT)?.minLevel).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("FIX C: the same hand raise arms NOTHING for a room with no configured boost (2026-08-26 Najat)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-26T13:45:00Z"));
      const { mock, controller, run } = setup({ hotLevel: 1 });
      await controller.ensureLoaded();
      await run(14.6, 6, 41);

      await controller.onUserGenLevel(HOT, 2);
      await run(14.6, 1, 41);

      // A comfort tap, not non-cooling evidence: no hold, and the floor stays L1.
      expect(mock.levelHolds.size).toBe(0);
      const status = controller.getStatus().acs.find((a) => a.deviceId === HOT);
      expect(status?.levelHold ?? null).toBeNull();
      expect(status?.minLevel).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("FIX C: an observed external raise off L1 arms nothing for a boost-less room", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-26T13:00:00Z"));
      const { mock, controller, run, observeHotAt } = setup({ hotLevel: 1 });
      await controller.ensureLoaded();
      // Outlast the boot source-change power-event window (~17 min of 15s
      // readings), so the ONLY reason nothing arms is the missing boost, not the
      // firmware-restore guard.
      await run(14.6, 68, 43, 15_000);

      observeHotAt(2);
      await run(14.6, 1, 43, 15_000);

      expect(mock.levelHolds.size).toBe(0);
      const status = controller.getStatus().acs.find((a) => a.deviceId === HOT);
      expect(status?.levelHold ?? null).toBeNull();
      expect(status?.minLevel).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// R9 — the shell half. The BAR a shed leaves behind is stamped from the
// pre-batch meter and the batch's own priced saving, and a shed counts as a
// restore's bounce whichever planner decided it. Both live in the shell, which
// is why they need a guard here as well as in raise.test.ts.
// ---------------------------------------------------------------------------

describe("LevelingControllerV2 — a room's own shed bars its restore (R9)", () => {
  function setup(shedIds: string[] = []) {
    const mock = createGradePool(
      {
        genLimitAmps: 15,
        priority: ["big", "small"],
        genAmpModels: { big: { baseAmps: 4.1, stepAmps: 2.45 }, small: { baseAmps: 2.3, stepAmps: 1.5 } },
      },
      shedIds,
    );
    const offs: string[] = [];
    const ons: string[] = [];
    const deps: LevelingDeps = {
      ...createDeps(),
      getTclCloud: () =>
        ({
          sendControl: async () => undefined,
          executeAcAction: async (id: string, action: Record<string, unknown>) => {
            if (action.power === 0) offs.push(id);
            if (action.power === 1) ons.push(id);
          },
        }) as never,
    };
    const controller = new LevelingControllerV2(mock.pool, deps);
    const power = new Map<string, boolean>([
      ["big", !shedIds.includes("big")],
      ["small", !shedIds.includes("small")],
    ]);
    const room = (id: string, temp: number, need: number) => ({
      device: { ...(acDevice(id, power.get(id) === true, 1) as object), power: power.get(id) === true, currentTemp: temp } as never,
      managed: true,
      needTier: "full" as const,
      needDelta: need,
      slotGenCap: null,
      slotKey: null,
    });
    const ctxOf = () => [room("big", 30, 3), room("small", 28, 2)] as never;
    let flip = 1;
    const run = async (amps: number, steps: number) => {
      for (let i = 0; i < steps; i++) {
        flip = -flip;
        controller.onPowerReading({ current_1: 0, current_2: amps + 0.01 * flip } as never);
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctxOf(), 40);
      }
    };
    const decisionsOf = () =>
      mock.journal.flatMap(
        (r) => JSON.parse(String(r.decisions ?? "[]")) as Array<{ blockedBy?: string; deviceId?: string }>,
      );
    return { mock, controller, offs, ons, power, run, decisionsOf };
  }

  it("does not re-admit the room into the hole its own shed dug", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T04:15:00Z"));
      const { controller, offs, ons, power, run, decisionsOf } = setup();
      await controller.ensureLoaded();

      // Ride over the limit until the reducer sheds exactly one room, then stop
      // pressing — a second shed would change the arithmetic being tested.
      for (let i = 0; i < 40 && offs.length === 0; i++) await run(15.7, 1);
      expect(offs).toHaveLength(1);
      power.set(offs[0], false);

      // The trough its own departure left: 12.5A, comfortably under the 14.9A
      // ceiling for a 2.3A return — and a lie, because the house it was shed out
      // of was 15.7A less the 2.3A that shed was priced to save. This is the
      // 07:19→07:20 shape, with the commanded-cut credit already spent.
      ons.length = 0;
      await run(12.5, 40);

      expect(ons).toHaveLength(0);
      expect(decisionsOf().some((d) => d.blockedBy === "own shed trough")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a re-shed inside the blame window grows the restore ladder", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T04:15:00Z"));
      const { controller, offs, ons, power, run } = setup(["small"]);
      await controller.ensureLoaded();

      // Plenty of room: the shed room comes back. Stop the moment it does, so
      // the re-shed lands inside the blame window rather than after a grade has
      // already called the restore a success.
      for (let i = 0; i < 90 && ons.length === 0; i++) await run(7.0, 1);
      expect(ons).toContain("small");
      power.set("small", true);

      // …and the line objects, so it goes straight back off. R9 asked whether
      // `noteFailure` covers this path rather than only a failed ADMISSION, and
      // it does — pinned here because the unconditional non-cooling pricing
      // (R9b) has nowhere stable to land without it.
      offs.length = 0;
      for (let i = 0; i < 24 && offs.length === 0; i++) await run(16.4, 1);
      expect(offs).toContain("small");
      const cooldown = controller.getStatus().acs.find((a) => a.deviceId === "small")?.restoreCooldownMs ?? 0;
      expect(cooldown).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// R6/R7 — per-AC compressor evidence from a graded off-drop, and the surface it
// gets. User, 2026-08-04, from his own experiment: "an off with 1 amp or less
// of drop means the compressor was not running".
//
// SHELL tests: the grading window, the amp model behind the comparison, and the
// per-device+level retention all live here; the arithmetic has its own guards
// in dead-window.test.ts.
// ---------------------------------------------------------------------------

describe("LevelingControllerV2 — a fan-sized off-drop says the compressor was off (R6)", () => {
  function setup(dropTo: number) {
    // 2.3A modelled at L1 — a real 1-ton, so a small drop MEANS something.
    const mock = createGradePool({ genAmpModels: { a: { baseAmps: 2.3, stepAmps: 1.5 } } });
    const a = { id: "a", name: "a", power: true, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1, currentTemp: 30 };
    const deps: LevelingDeps = {
      ...createDeps(),
      getTclCloud: () =>
        ({
          sendControl: async () => undefined,
          executeAcAction: async (_id: string, action: { power?: number }) => {
            if (action.power === 0) a.power = false;
          },
        }) as never,
    };
    const controller = new LevelingControllerV2(mock.pool, deps);
    const ctx = [{ device: a as never, managed: true, needTier: "full" as const, needDelta: 0.3, slotGenCap: null, slotKey: null }];
    let flip = 1;
    const run = async (genAmps: number, steps: number, outdoorC: number | null = 44) => {
      for (let i = 0; i < steps; i++) {
        flip = -flip;
        controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctx, outdoorC);
      }
    };
    return { mock, controller, a, run, dropTo };
  }

  it("records the evidence, surfaces it, and turns it into a learned L1 hold", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T14:00:00Z"));
      // Settle high enough that the 4-wide median is really there before the
      // shed — the drop is measured from the SMOOTHED meter, so a lagging
      // median would measure the settle rather than the compressor.
      const { mock, controller, a, run } = setup(15.1);
      await controller.ensureLoaded();

      await run(14.5, 12);
      await run(16.5, 4);
      expect(a.power).toBe(false);
      // …and the meter barely moves. That is the user's own experiment,
      // reproduced: a level nothing was drawing.
      await run(15.1, 16);

      const status = controller.getStatus().acs.find((s) => s.deviceId === "a");
      expect(status?.coolingState).toBe("off"); // the room is off, so that wins
      // …and the evidence became a learned hold at the outdoor temperature it
      // was observed at (R14's first trigger, arriving from the METER).
      expect(mock.levelHolds.get("a")).toMatchObject({ level: 1, outdoorC: 44 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a whole compressor's worth of fall records nothing — that room was running", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T14:00:00Z"));
      const { mock, controller, a, run } = setup(13.0);
      await controller.ensureLoaded();

      await run(14.5, 12);
      await run(16.5, 4);
      expect(a.power).toBe(false);
      await run(13.0, 16); // ~2.5A gone: the compressor was there

      expect(mock.levelHolds.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// R6b (2026-08-06) — the RISE side of the same experiment, REPORT-ONLY. The
// off-drop above only speaks when a room is going off anyway; a lone raise off
// L1 speaks on the way UP, on a batch the house was going to send regardless.
//
// ⚠ It observes and arms NOTHING (demoted on review the day it was written).
// The rise it measures is a whole-house smoothed delta with no non-AC load
// subtracted, so any household step inside the 240 s window reads as a
// compressor — see the heater regression at the bottom of this block. Every
// test here therefore asserts the REPORT, and that no hold and no
// `compressorOffLikely` follow it.
//
// SHELL tests, and they have to be: the whole mechanism lives in the grading
// shell (`pendingGrades`, the arm-time exclusions, `learnAfter`,
// `bornContaminated`) which `scenario.ts` does not model at all — the standing
// harness debt recorded in the SKILL. The arithmetic and the exclusion rule have
// their own pure guards in dead-window.test.ts.
// ---------------------------------------------------------------------------

describe("LevelingControllerV2 — a lone raise off L1 REPORTS on the compressor (R6b)", () => {
  /** One 1-ton room on gen: 2.3A at L1, so a level:1>2 step is priced 1.5A. */
  function setup(
    opts: {
      level?: number;
      maxLevel?: number;
      peers?: boolean;
      levelBoosts?: Record<string, { minLevel: number; outdoorAtLeastC: number }>;
    } = {},
  ) {
    const models = { a: { baseAmps: 2.3, stepAmps: 1.5 }, b: { baseAmps: 2.3, stepAmps: 1.5 } };
    const mock = createGradePool({
      genLimitAmps: 15,
      priority: ["a", "b"],
      genAmpModels: models,
      ...(opts.levelBoosts != null ? { levelBoosts: opts.levelBoosts } : {}),
    });
    const make = (id: string) => ({
      id,
      name: id,
      power: true,
      generatorMode: opts.level ?? 1,
      maxGeneratorLevel: opts.maxLevel ?? 2,
      fanSpeed: 1,
      currentTemp: 32,
    });
    const devices = opts.peers === true ? [make("a"), make("b")] : [make("a")];
    const deps: LevelingDeps = {
      ...createDeps(),
      getTclCloud: () =>
        ({
          sendControl: async (id: string, cmd: string, value: number) => {
            if (cmd !== "set_generator_mode") return;
            const d = devices.find((x) => x.id === id);
            if (d != null) d.generatorMode = value;
          },
          executeAcAction: async () => undefined,
        }) as never,
    };
    const controller = new LevelingControllerV2(mock.pool, deps);
    const ctx = devices.map((device) => ({
      device: device as never,
      managed: true,
      needTier: "full" as const,
      needDelta: 3,
      slotGenCap: null,
      slotKey: null,
    }));
    let flip = 1;
    const run = async (genAmps: number, steps: number, outdoorC: number | null = 44) => {
      for (let i = 0; i < steps; i++) {
        flip = -flip;
        controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctx as never, outdoorC);
      }
    };
    return { mock, controller, devices, run };
  }

  it("REPORTS — but arms nothing — when the rise is a whole compressor above its step", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T05:00:00Z"));
      const { mock, controller, devices, run } = setup();
      await controller.ensureLoaded();

      await run(8.0, 8); // calm ≥ raiseCalmSeconds → the lone L1→L2 raise ships
      expect(devices[0].generatorMode).toBe(2);
      // …and the meter rises 3.7A for a step priced at 1.5A. A level step does
      // not do that; a compressor starting from a fan does — OR the house did
      // something we cannot see, which is why this only reports. Held past
      // AC_RAMP_MS so the sample is the settled peak, not a slice of ramp.
      await run(11.7, 60);

      // The observation IS emitted, and it is durable (docker logs rotate).
      const report = mock.journal.find((j) => j.reason === "compressor_report");
      expect(report).toBeDefined();
      expect(String(report?.decisions)).toContain("report-only");
      expect(String(report?.decisions)).toContain("compressor may not have been running at L1");

      // …and it changes NOTHING. No 6h hold, no ladder clamp, no non-cooling
      // verdict — those cost the hottest room its amps, and this measurement is
      // not attributable enough to spend them (review, 2026-08-06).
      expect(mock.levelHolds.size).toBe(0);
      const status = controller.getStatus().acs.find((s) => s.deviceId === "a");
      expect(status?.minLevel).toBe(1);
      expect(status?.levelHold ?? null).toBeNull();
      expect(status?.coolingState).not.toBe("compressor_off");
    } finally {
      vi.useRealTimers();
    }
  });

  it("REGRESSION 2026-08-06 (review): a heater step inside the grading window must not mint a hold", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T05:00:00Z"));
      const { mock, controller, devices, run } = setup();
      await controller.ensureLoaded();

      await run(8.0, 8); // the lone L1→L2 raise ships
      expect(devices[0].generatorMode).toBe(2);
      // The step is REAL and ordinary: 1.5A, exactly what it was priced at.
      await run(9.5, 18);
      // …and ninety seconds into the 240s window this house's own water heater
      // (3.4A) switches on. `peakDeltaAmps` is a whole-house ratcheted delta
      // with no non-AC load subtracted, so the window now measures 4.9A against
      // a 3.5A bar and the detector fires on a kettle.
      await run(12.9, 45);

      // It may say so out loud…
      expect(mock.journal.some((j) => j.reason === "compressor_report")).toBe(true);
      // …but a 6-hour L1 hold armed on a household appliance is the exact
      // failure invariant 56 was written to kill, arriving from the amps side.
      expect(mock.levelHolds.size).toBe(0);
      const status = controller.getStatus().acs.find((s) => s.deviceId === "a");
      expect(status?.minLevel).toBe(1);
      expect(status?.levelHold ?? null).toBeNull();
      expect(status?.coolingState).not.toBe("compressor_off");
    } finally {
      vi.useRealTimers();
    }
  });

  it("REGRESSION 2026-08-06 02:36:42: an ordinary step reports nothing", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T05:00:00Z"));
      const { mock, controller, devices, run } = setup();
      await controller.ensureLoaded();

      await run(8.0, 8);
      expect(devices[0].generatorMode).toBe(2);
      // 1.5A — exactly the step price, which is what the live L1→L2 raise
      // measured that morning (1.5–1.9A). Nothing anomalous happened, and the
      // detector must not manufacture evidence out of a normal raise.
      await run(9.5, 60);

      // Nothing to report and — as always now — nothing armed. The report is
      // what these tests pin since the demotion: a hold assertion alone would
      // pass trivially and stop guarding the detector at all.
      expect(mock.journal.some((j) => j.reason === "compressor_report")).toBe(false);
      expect(mock.levelHolds.size).toBe(0);
      expect(controller.getStatus().acs.find((s) => s.deviceId === "a")?.minLevel).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing about a raise that is not off L1", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T05:00:00Z"));
      // Starts at L2 with L3 available: the same anomalous rise, one level up.
      // The L2 comfort floor is what lets the gen-entry clamp (invariant 13)
      // leave the room where it is, so the raise under test really is L2→L3.
      const { mock, controller, devices, run } = setup({
        level: 2,
        maxLevel: 3,
        levelBoosts: { a: { minLevel: 2, outdoorAtLeastC: 40 } },
      });
      await controller.ensureLoaded();

      await run(8.0, 8);
      expect(devices[0].generatorMode).toBe(3);
      await run(11.7, 60);

      // The observation is about L1. A room that drew a lot more at L3 than its
      // model said was simply working harder — nothing says L2 was dead.
      expect(mock.journal.some((j) => j.reason === "compressor_report")).toBe(false);
      expect(mock.levelHolds.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second room moving inside the window voids the experiment (invariant 23)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T05:00:00Z"));
      const { mock, controller, devices, run } = setup({ peers: true });
      await controller.ensureLoaded();

      await run(8.0, 30); // both rooms climb off L1 over the calm windows
      expect(devices.filter((d) => d.generatorMode === 2).length).toBe(2);
      await run(13.5, 60); // a big house-wide rise — attributable to NEITHER

      // One actuator is the whole premise. With two rooms moving, the rise
      // cannot be assigned, so nothing is reported for either — the same
      // certification the cost learner requires, reaching the report path.
      expect(mock.journal.some((j) => j.reason === "compressor_report")).toBe(false);
      expect(mock.levelHolds.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The gated proactive shed (the swap), 2026-08-06. The DECISION is pure and
// pinned in raise.test.ts; the whole-house replay is in scenarios.test.ts.
//
// SHELL guards, for what neither of those can see: the shed ROW and the PUSH a
// donor gets (both are I/O), and the fact that a `power_off` — not only a
// `set_level` — stamps the funding cooldown that stops the donor undoing the
// trade.
// ---------------------------------------------------------------------------

describe("LevelingControllerV2 — a donor switched off for a hotter room (the swap)", () => {
  function setup() {
    const mock = createGradePool({
      genLimitAmps: 15,
      priority: ["mid", "cool", "hot"],
      genAmpModels: {
        hot: { baseAmps: 4.5, stepAmps: 2.4 },
        mid: { baseAmps: 2.5, stepAmps: 1.6 },
        cool: { baseAmps: 2.7, stepAmps: 1.6 },
      },
    }, ["hot"]);
    const offs: string[] = [];
    const ons: string[] = [];
    const pushes: string[] = [];
    const deps: LevelingDeps = {
      ...createDeps(),
      broadcast: async (payload: Record<string, unknown>) => {
        pushes.push(String(payload.body ?? ""));
      },
      getTclCloud: () =>
        ({
          sendControl: async () => undefined,
          executeAcAction: async (id: string, action: Record<string, unknown>) => {
            if (action.power === 0) offs.push(id);
            if (action.power === 1) ons.push(id);
          },
        }) as never,
    };
    const controller = new LevelingControllerV2(mock.pool, deps);
    const power = new Map<string, boolean>([
      ["hot", false],
      ["mid", true],
      ["cool", true],
    ]);
    // comfortTargetC is 26, so the thermometer IS the rank: mid 3.0, hot 2.0,
    // cool 0.5. `hot` is 1.5°C hotter than `cool` — clear of the 1.0°C gap —
    // and `mid` is hotter than both, so it can never be the donor.
    const room = (id: string, temp: number, need: number) => ({
      device: {
        ...(acDevice(id, power.get(id) === true, 1) as object),
        power: power.get(id) === true,
        currentTemp: temp,
      } as never,
      managed: true,
      needTier: "full" as const,
      needDelta: need,
      slotGenCap: null,
      slotKey: null,
    });
    const ctxOf = () => [room("mid", 29, 3), room("cool", 26.5, 0.5), room("hot", 28, 2)] as never;
    let flip = 1;
    const run = async (amps: number, steps: number) => {
      for (let i = 0; i < steps; i++) {
        flip = -flip;
        controller.onPowerReading({ current_1: 0, current_2: amps + 0.01 * flip } as never);
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctxOf(), 40);
      }
    };
    /** Same cadence on the GRID channel — a real changeover, not a gap. */
    const runGrid = async (amps: number, steps: number) => {
      for (let i = 0; i < steps; i++) {
        flip = -flip;
        controller.onPowerReading({ current_1: amps + 0.01 * flip, current_2: 0 } as never);
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctxOf(), 40);
      }
    };
    const decisionsOf = () =>
      mock.journal.flatMap(
        (r) => JSON.parse(String(r.decisions ?? "[]")) as Array<{ blockedBy?: string; action?: string; deviceId?: string }>,
      );
    const shedReasons = () => mock.shedReasons;
    return { journal: mock.journal, costs: mock.costs, controller, offs, ons, pushes, power, run, runGrid, decisionsOf, shedReasons };
  }

  it("records the shed row and the push naming the room the donation was FOR", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T02:40:00Z"));
      const { controller, journal, offs, pushes, run, shedReasons } = setup();
      await controller.ensureLoaded();

      // 11.8A: `hot` needs 4.5A against a 14.9A ceiling and both running rooms
      // are already at their floors, so nothing but a trade can bring it back.
      await run(11.8, 12);

      expect(offs).toEqual(["cool"]);
      // It is the TRADE that switched the room off, not the ladder — the
      // journal reason is what a forensic pass reads first.
      expect(journal.some((r) => r.reason === "proactive_shed")).toBe(true);
      // A shed must be LOUD, and a proactive one must say who it was for —
      // "to protect the breaker" would be a lie about a calm line.
      expect(shedReasons().some((r) => r.includes("so hot could run"))).toBe(true);
      expect(pushes.some((b) => b.includes("cool") && b.includes("hot"))).toBe(true);
      expect(pushes.some((b) => b.includes("protect the"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ships the donor off and the receiver's restore in ONE batch, not to a peer", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T02:40:00Z"));
      const { controller, offs, ons, run, decisionsOf } = setup();
      await controller.ensureLoaded();
      await run(11.8, 12);
      // User directive 2026-08-08: instant sequencing. The off and the receiver's
      // gentle restore ship TOGETHER — the freed amps are never handed to `mid`
      // (the hottest room, one step from L2), and the receiver does not wait a
      // later tick for the meter to show the saving.
      expect(offs).toEqual(["cool"]);
      expect(ons).toEqual(["hot"]);
      // …and the receiver's admission is journaled as a same-batch restore, not
      // the old "swap landing" deferral.
      expect(
        decisionsOf().some((d) => d.deviceId === "hot" && String(d.action).startsWith("restore @L")),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bars the DONOR's own restore for the funding cooldown (a power_off stamps it)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T02:40:00Z"));
      const { controller, offs, ons, power, run, decisionsOf } = setup();
      await controller.ensureLoaded();
      await run(11.8, 12);
      // The receiver comes back in the SAME batch now (user 2026-08-08); confirm
      // it on so the shell releases the trade and confirm-or-resend stays quiet.
      expect(offs).toEqual(["cool"]);
      expect(ons).toContain("hot");
      power.set("cool", false);
      power.set("hot", true);

      // The donor may not take its donation back while the cooldown runs —
      // without the `power_off` arm of the stamp it would simply be restored on
      // the next calm window, undoing the trade it just paid for. (Ticks inside
      // FUNDING_COOLDOWN_MS.)
      await run(6.0, 8);
      await run(6.0, 6);

      expect(decisionsOf().some((d) => d.deviceId === "cool" && d.blockedBy === "donation cooldown")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("journals the 2-command trade but never LEARNS a cost from it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T02:40:00Z"));
      const { controller, offs, ons, power, journal, costs, run } = setup();
      await controller.ensureLoaded();
      await run(11.8, 12);
      // The trade ships [power_off(cool), power_on(hot)] — TWO meter commands, so
      // the grading shell (`meterCmds.length === 1`) journals it but never learns.
      expect(offs).toEqual(["cool"]);
      expect(ons).toContain("hot");
      // Confirm the receiver so no lone confirm-or-resend restore appears (that
      // would be a single-command window and could learn on its own).
      power.set("cool", false);
      power.set("hot", true);
      // Hold the meter high enough that the shed donor cannot refit as a lone
      // restore once its funding cooldown lapses, then run the grade windows out.
      await run(12.6, 30);
      // Journaled…
      expect(journal.some((r) => r.reason === "proactive_shed")).toBe(true);
      // …but never learned: a LONE shed of `cool` would have booked on@L1
      // (negated, invariant 55) and the receiver's on@L1 is a free sample — the
      // 2-command batch forfeits both (the accepted trade-off, user 2026-08-08).
      expect(costs.filter((c) => c.transition.startsWith("on@"))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a CHANGEOVER releases the reservation — the trade was priced on a budget that is gone", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T02:40:00Z"));
      const { controller, offs, power, run, runGrid, decisionsOf } = setup();
      await controller.ensureLoaded();
      // The record itself, because that is the thing under test: every OUTWARD
      // effect of a stale swap is masked on the far side of a changeover (the
      // entry mode returns before `planRaise`, and GRID_FULL restores the
      // receiver outright), so an assertion on decisions would pass with the
      // clear deleted — it did, on the first draft of this test.
      const shell = controller as unknown as { swap: { donorId: string; receiverId: string } | null };

      await run(11.8, 12);
      expect(offs).toEqual(["cool"]);
      power.set("cool", false);

      // The reservation is live: the receiver's amps are held across ticks.
      await run(11.8, 4);
      expect(decisionsOf().some((d) => d.deviceId === "hot" && d.blockedBy === "swap landing")).toBe(true);
      expect(shell.swap).toMatchObject({ donorId: "cool", receiverId: "hot" });

      // gen → grid. `clearOnSourceChange` drops the trade: it reserved amps on a
      // budget that no longer exists, and GRID_FULL re-decides who runs from
      // scratch. Carried over, it would park the next gen session's raise phase
      // for the rest of SWAP_RESERVATION_MS and bar a fresh trade for the same
      // window. (Mirrored in `scenario.ts` `setSource`.)
      await runGrid(11.8, 2);
      expect(shell.swap).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Flicker patience (invariant 58 follow-up, 2026-08-08). A restore refused ONLY
// by the supply-flicker margin (`chargedRestoreCeiling`) fits the bare ceiling
// and is waiting for the line to settle, not out of headroom. The DECISION —
// reserve while waiting, admit at the bare ceiling once patience expires — is
// pure and pinned in raise.test.ts. The SHELL owns the per-room anchor: it
// stamps a flicker-only refusal, holds it across ticks, drops it when the room
// stops being refused (it restored), and clears it on a source change.
// ---------------------------------------------------------------------------
describe("LevelingControllerV2 — flicker-patience anchor lifecycle (2026-08-08)", () => {
  function setup() {
    const mock = createGradePool(
      {
        genLimitAmps: 15,
        priority: ["big", "small"],
        genAmpModels: { big: { baseAmps: 4.1, stepAmps: 2.45 }, small: { baseAmps: 2.3, stepAmps: 1.5 } },
        // A long restore-calm gate on purpose: the supply-flicker estimate needs
        // ~6 wobbly readings to build, and this keeps calm from being satisfied
        // before it does — otherwise `small` would restore in the flicker-free
        // window before the wobble is even measurable, and the case under test
        // (a flicker-ONLY refusal) never arises.
        raiseCalmSeconds: 45,
        restoreCalmSeconds: 45,
      },
      ["small"],
    );
    const ons: string[] = [];
    const deps: LevelingDeps = {
      ...createDeps(),
      getTclCloud: () =>
        ({
          sendControl: async () => undefined,
          executeAcAction: async (id: string, action: Record<string, unknown>) => {
            if (action.power === 1) ons.push(id);
          },
        }) as never,
    };
    const controller = new LevelingControllerV2(mock.pool, deps);
    const power = new Map<string, boolean>([["big", true], ["small", false]]);
    const room = (id: string, temp: number, need: number) => ({
      device: { ...(acDevice(id, power.get(id) === true, 1) as object), power: power.get(id) === true, currentTemp: temp } as never,
      managed: true,
      needTier: "full" as const,
      needDelta: need,
      slotGenCap: null,
      slotKey: null,
    });
    const ctxOf = () => [room("big", 30, 3), room("small", 28, 2)] as never;
    // A generator that WOBBLES ±0.35A reading-to-reading — a ~0.7A flicker
    // estimate. At a 12.4A mean `small`'s 2.3A return fits the 14.9A bare ceiling
    // (14.7) but not the flicker-charged one (~14.2), so it is refused ONLY by
    // the wobble.
    let flip = 1;
    const runGen = async (amps: number, steps: number) => {
      for (let i = 0; i < steps; i++) {
        flip = -flip;
        controller.onPowerReading({ current_1: 0, current_2: amps + 0.35 * flip } as never);
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctxOf(), 40);
      }
    };
    /** Same cadence on the GRID channel — a real changeover, not a gap. */
    const runGrid = async (amps: number, steps: number) => {
      for (let i = 0; i < steps; i++) {
        flip = -flip;
        controller.onPowerReading({ current_1: amps + 0.01 * flip, current_2: 0 } as never);
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctxOf(), 40);
      }
    };
    const anchors = () =>
      (controller as unknown as { flickerRefusedSince: Map<string, number> }).flickerRefusedSince;
    return { controller, ons, power, runGen, runGrid, anchors };
  }

  it("stamps a flicker-only refusal, holds it across ticks, then admits at the bare ceiling", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T04:15:00Z"));
      const { controller, ons, power, runGen, anchors } = setup();
      await controller.ensureLoaded();

      // Ride the wobbly 12.4A line. `small` fits the bare ceiling but the flicker
      // charge refuses it, so once the estimate builds it is flicker-refused and
      // the shell stamps its anchor.
      await runGen(12.4, 10);
      expect(anchors().has("small")).toBe(true);
      expect(ons).not.toContain("small");
      const stampedAt = anchors().get("small")!;

      // The anchor is HELD, not re-stamped, while the refusal stands.
      await runGen(12.4, 4);
      expect(anchors().get("small")).toBe(stampedAt);
      expect(ons).not.toContain("small");

      // Past FLICKER_PATIENCE_MS of unbroken refusal it comes back at the bare
      // ceiling — a wobble that never settles must not strand the room forever.
      for (let i = 0; i < 40 && !ons.includes("small"); i++) await runGen(12.4, 1);
      expect(ons).toContain("small");

      // …and once the restore confirms, the room leaves the queue and its anchor
      // is gone: it is no longer flicker-refused.
      power.set("small", true);
      await runGen(12.4, 3);
      expect(anchors().has("small")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the anchor on a source change — it was measured against a supply that is gone", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T04:15:00Z"));
      const { controller, runGen, runGrid, anchors } = setup();
      await controller.ensureLoaded();

      await runGen(12.4, 10);
      expect(anchors().has("small")).toBe(true);

      // gen → grid: the entry policy re-decides who runs from scratch, and the
      // anchor was priced against a generator that no longer feeds the house.
      await runGrid(12.4, 2);
      expect(anchors().has("small")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-08-07 bounce-backoff hardening (independent review). Two gaps the scenario
// harness cannot see, both shell-side. (1) A stale bounce count must not outlive
// the restore episode: an external ON ends it (`clearBounces`), and our own
// `restore_confirmed` must NOT clear it (the bounce books ~60s LATER at the
// re-shed — clearing on the confirm would cap the count at 1 and kill the
// compounding). A `set_level` cut of a recently restored room is a ladder failure
// but not a shed bounce. (2) One physical off can be seen twice — the REST tap
// credits immediately and the device poll re-observes it because `onUserPowerOff`
// never updates `prevPowerStates` — and must credit the meter and the peer bars
// exactly once.
// ---------------------------------------------------------------------------
describe("LevelingControllerV2 — bounce-count lifecycle & off-credit dedup (2026-08-07)", () => {
  const tclStub = () =>
    ({ sendControl: async () => undefined, executeAcAction: async () => undefined }) as never;
  const pacingOf = (c: LevelingControllerV2) => (c as unknown as { pacing: PacingState }).pacing;
  const setPacing = (c: LevelingControllerV2, p: PacingState) => {
    (c as unknown as { pacing: PacingState }).pacing = p;
  };
  const shedBarOf = (c: LevelingControllerV2) =>
    (c as unknown as { shedBar: Map<string, { amps: number; at: number; credited: number }> }).shedBar;

  it("an external OFF→ON clears the bounce count; a restore_confirmed does NOT (⚠ would cap it at 1)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-07T14:20:00Z"));
      const mock = createGradePool({}, ["b"]);
      const controller = new LevelingControllerV2(mock.pool, { ...createDeps(), getTclCloud: tclStub });
      await controller.ensureLoaded();
      // `a` boots off-but-not-shed (its ON is the external branch); `b` boots shed
      // (its ON is the leveler's restore_confirmed branch).
      const a = { id: "a", name: "a", power: false, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const b = { id: "b", name: "b", power: false, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const ctx = [
        { device: a as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
        { device: b as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null, slotKey: null },
      ];
      let flip = 1;
      const run = async (steps: number) => {
        for (let i = 0; i < steps; i++) {
          flip = -flip;
          // High on the 15A line so the shed room `b` is never restorable — only
          // the flips below change its power state.
          controller.onPowerReading({ current_1: 0, current_2: 14 + 0.01 * flip } as never);
          vi.advanceTimersByTime(5_000);
          await controller.tick(ctx, 30);
        }
      };
      await run(6); // establish the prev-power baseline (both off)
      // Two shed bounces booked on each room's restore entry.
      const t = Date.now();
      let p = pacingOf(controller);
      for (const id of ["a", "b"]) p = noteFailure(noteFailure(p, id, "restore", t, true), id, "restore", t, true);
      setPacing(controller, p);
      expect(restoreBounces(pacingOf(controller), "a")).toBe(2);
      expect(restoreBounces(pacingOf(controller), "b")).toBe(2);

      a.power = true; // a household member's ON — the external branch
      b.power = true; // the leveler's restore lands — the restore_confirmed branch
      await run(2);
      expect(restoreBounces(pacingOf(controller), "a"), "external ON ends the episode").toBe(0);
      expect(
        restoreBounces(pacingOf(controller), "b"),
        "restore_confirmed must NOT clear it — the bounce books ~60s after the confirm",
      ).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a set_level cut of a recently restored room books a failure but NOT a bounce", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-07T14:20:00Z"));
      const mock = createGradePool({
        priority: ["a", "b"],
        genAmpModels: { a: { baseAmps: 2, stepAmps: 2 }, b: { baseAmps: 2, stepAmps: 2 } },
      });
      const controller = new LevelingControllerV2(mock.pool, { ...createDeps(), getTclCloud: tclStub });
      await controller.ensureLoaded();
      // `a` at L1 (its floor), `b` at L2 with a level to cut — both hot.
      const a = { id: "a", name: "a", power: true, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
      const b = { id: "b", name: "b", power: true, generatorMode: 2, maxGeneratorLevel: 3, fanSpeed: 1 };
      const ctx = [
        { device: a as never, managed: true, needTier: "full" as const, needDelta: 6, slotGenCap: null, slotKey: null },
        { device: b as never, managed: true, needTier: "full" as const, needDelta: 6, slotGenCap: null, slotKey: null },
      ];
      let flip = 1;
      const run = async (steps: number) => {
        for (let i = 0; i < steps; i++) {
          flip = -flip;
          // ~0.5A over the 15A line: the ladder's cheapest rung is a single level
          // cut of `b` (L2→L1), not a shed.
          controller.onPowerReading({ current_1: 0, current_2: 15.5 + 0.01 * flip } as never);
          vi.advanceTimersByTime(5_000);
          await controller.tick(ctx, 30);
        }
      };
      await run(4); // settle
      // `b` was restored moments ago — the attribution window is open on it.
      setPacing(controller, noteAttempt(pacingOf(controller), "b", "restore", Date.now(), 15.5));
      await run(8);
      // The reducer cut b's LEVEL (not a shed), and that is a failure for the
      // ladder but NOT a shed bounce.
      expect(restoreFailures(pacingOf(controller), "b")).toBeGreaterThanOrEqual(1);
      expect(restoreBounces(pacingOf(controller), "b")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("one physical off credits the peer bar exactly once, even seen twice (REST tap + device poll)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-07T14:20:00Z"));
      const mock = createGradePool({ genAmpModels: { y: { baseAmps: 2, stepAmps: 2 } } });
      const controller = new LevelingControllerV2(mock.pool, { ...createDeps(), getTclCloud: tclStub });
      await controller.ensureLoaded();
      const now = Date.now();
      // Force gen so `creditRoomOff` runs, and give a bounced room `x` a live bar.
      (controller as unknown as { meterState: { source: string } }).meterState.source = "gen";
      setPacing(controller, noteFailure(pacingOf(controller), "x", "restore", now, true)); // bounces["x"]=1
      shedBarOf(controller).set("x", { amps: 12, at: now, credited: 0 });
      const credit = (id: string, when: number) =>
        (controller as unknown as { creditRoomOff: (id: string, lvl: number | null, now: number) => void }).creditRoomOff(id, 1, when);

      credit("y", now); // the REST tap
      expect(shedBarOf(controller).get("x")!.credited).toBeCloseTo(2, 1);
      credit("y", now + 5_000); // the device poll, same off → deduped
      expect(shedBarOf(controller).get("x")!.credited, "same physical off, one credit").toBeCloseTo(2, 1);
      // An ON in between clears the stamp — a genuine LATER off credits again.
      (controller as unknown as { noteExternalOn: (id: string, now: number) => void }).noteExternalOn("y", now + 10_000);
      credit("y", now + 15_000);
      expect(shedBarOf(controller).get("x")!.credited, "new off after an ON credits again").toBeCloseTo(4, 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Amp evidence releases the ramp WINDOW before its 240s clock (user directive,
// 2026-08-08: "we can watch the amps to know if it worked and stable without the
// need to wait the end of time"). A ramp is PROVEN done only once its absorption
// ratchet has crossed the "a compressor started" bar AND stopped climbing — an
// under-modelled compressor still climbing past its model has a live growth stamp
// and is never called done (the 2026-07-27 preferShed attribution depends on it),
// and a ratchet under the bar keeps its full window (the changeover dead-window
// trap). `rampWindowOpen` reads the exact `rampUntil` the release deletes.
// ---------------------------------------------------------------------------
describe("LevelingControllerV2 — amp evidence releases a ramp before its 240s clock", () => {
  function setup() {
    // base 2.5 -> committed(L1) 2.5A, started bar min(1.0, 0.4x2.5) = 1.0A.
    const mock = createGradePool({ genAmpModels: { a: { baseAmps: 2.5, stepAmps: 2.0 } } });
    const a = { id: "a", name: "a", power: true, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
    const deps: LevelingDeps = {
      ...createDeps(),
      getTclCloud: () => ({ sendControl: async () => undefined, executeAcAction: async () => undefined }) as never,
    };
    const controller = new LevelingControllerV2(mock.pool, deps);
    // needDelta 0 (satisfied) -> the room never wants a raise, so `rampWindowOpen`
    // is the only thing moving.
    const ctx = [{ device: a as never, managed: true, needTier: "satisfied" as const, needDelta: 0, slotGenCap: null, slotKey: null }];
    let flip = 1;
    const feed = async (genAmps: number) => {
      flip = -flip;
      controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
      vi.advanceTimersByTime(5_000);
      await controller.tick(ctx as never, 30);
    };
    const run = async (genAmps: number, steps: number) => {
      for (let i = 0; i < steps; i++) await feed(genAmps);
    };
    return { controller, feed, run };
  }

  it("full absorption releases the window — ramping drops well before 240s", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T10:00:00Z"));
      const { controller, run } = setup();
      await controller.ensureLoaded();
      await run(3.0, 12); // gen up, L1 confirmed, smoothed ~3.0
      controller.rearmRamp(["a"]); // an ordinary ramp, baseline ~3.0
      expect(controller.rampWindowOpen("a")).toBe(true);
      // The meter rises to the whole 2.5A committed draw and then holds steady —
      // full absorption, then the 45s plateau.
      await run(5.5, 26); // 130s — well under the 240s clock
      expect(controller.rampWindowOpen("a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a compressor that plateaus BELOW its model still releases (started + settled)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T10:00:00Z"));
      const { controller, run } = setup();
      await controller.ensureLoaded();
      await run(3.0, 12);
      controller.rearmRamp(["a"]);
      // Rises ~1.5A — over the 1.0A started bar, under the 2.5A model — then holds.
      // Catches the room the weather never pushes to its cap.
      await run(4.5, 26);
      expect(controller.rampWindowOpen("a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a room that absorbs almost nothing keeps its FULL window (restart-protection trap)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T10:00:00Z"));
      const { controller, run } = setup();
      await controller.ensureLoaded();
      await run(3.0, 12);
      controller.rearmRamp(["a"]);
      // The meter barely moves — under the started bar, so no compressor has
      // demonstrably started (the changeover dead window). NEVER on flatness.
      await run(3.4, 40); // 200s of ~0.4A absorbed, still inside the 240s clock
      expect(controller.rampWindowOpen("a")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a still-climbing ratchet is never called done — growth keeps the window alive", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T10:00:00Z"));
      const { controller, feed } = setup();
      await controller.ensureLoaded();
      for (let i = 0; i < 12; i++) await feed(3.0);
      controller.rearmRamp(["a"]);
      // Over the started bar and STILL climbing toward — but never reaching — the
      // 2.5A model, so the growth stamp never goes stale and the window holds.
      for (let i = 0; i < 38; i++) await feed(4.0 + i * 0.03); // 4.0->5.11, absorbed <2.5, 190s
      expect(controller.rampWindowOpen("a")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The settle window exits EARLY once the meter has digested the batch (user
// directive, 2026-08-08). The window protects the meter's digestion of the last
// command batch; when nothing is owed in either direction — no commanded fall
// still landing and no unabsorbed spend commitment — it has nothing left to
// protect. It may only ever get SHORTER (a cut still landing keeps the 30s
// clock), and never before the 10s FAN_SETTLE floor.
// ---------------------------------------------------------------------------
describe("LevelingControllerV2 — the settle window exits early when the batch is digested", () => {
  function setup(startLevel = 1, slotGenCap: number | null = 2) {
    const mock = createGradePool({ genAmpModels: { a: { baseAmps: 2.5, stepAmps: 2.0 } } });
    const a = { id: "a", name: "a", power: true, generatorMode: startLevel, maxGeneratorLevel: 3, fanSpeed: 1, currentTemp: 30 };
    const deps: LevelingDeps = {
      ...createDeps(),
      getTclCloud: () => ({
        sendControl: async (id: string, cmd: string, value: number) => {
          if (cmd === "set_generator_mode") a.generatorMode = value;
        },
        executeAcAction: async (_id: string, action: { power?: number }) => {
          if (action.power === 0) a.power = false;
        },
      }) as never,
    };
    const controller = new LevelingControllerV2(mock.pool, deps);
    const ctx = [{ device: a as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap, slotKey: null }];
    let flip = 1;
    const feed = async (genAmps: number) => {
      flip = -flip;
      controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
      vi.advanceTimersByTime(5_000);
      await controller.tick(ctx as never, 30);
    };
    const mode = () => controller.getStatus().mode;
    return { controller, a, feed, mode };
  }

  it("returns to NORMAL before the 30s clock once the raise's debit absorbs, but never before 10s", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T10:00:00Z"));
      const s = setup();
      await s.controller.ensureLoaded();
      // Calm builds and the hot room raises L1->L2 — the batch arms SETTLING and a
      // committed-but-unmetered jump debit.
      let raiseAt = 0;
      for (let i = 0; i < 40 && raiseAt === 0; i++) {
        await s.feed(3.0);
        if (s.a.generatorMode === 2) raiseAt = Date.now();
      }
      expect(raiseAt, "raise never shipped").toBeGreaterThan(0);
      // The status reports the mode from BEFORE the batch armed SETTLING, so the
      // window shows up on the next tick. The meter then climbs to show the raised
      // L2 draw and the jump debit absorbs — watch SETTLING give way to NORMAL.
      let normalAt = 0;
      let sawSettling = false;
      for (let i = 0; i < 10 && normalAt === 0; i++) {
        await s.feed(8.0);
        if (s.mode() === "SETTLING") sawSettling = true;
        else if (s.mode() === "NORMAL" && sawSettling) normalAt = Date.now();
      }
      expect(sawSettling, "the batch never entered SETTLING").toBe(true);
      expect(normalAt, "never returned to NORMAL").toBeGreaterThan(0);
      expect(normalAt - raiseAt).toBeGreaterThanOrEqual(10_000); // the FAN_SETTLE floor
      expect(normalAt - raiseAt).toBeLessThan(30_000); // before the SETTLE_MS clock
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds SETTLING to the clock while the raise's jump debit still owes amps", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T10:00:00Z"));
      const s = setup();
      await s.controller.ensureLoaded();
      let raiseAt = 0;
      for (let i = 0; i < 40 && raiseAt === 0; i++) {
        await s.feed(3.0);
        if (s.a.generatorMode === 2) raiseAt = Date.now();
      }
      expect(raiseAt, "raise never shipped").toBeGreaterThan(0);
      // The meter does NOT climb — the jump debit never absorbs — so the window
      // may not exit early. It rides its 30s clock instead.
      for (let i = 0; i < 4; i++) await s.feed(3.0); // +20s, still inside the clock
      expect(s.mode()).toBe("SETTLING");
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds SETTLING to the clock while a commanded cut is still landing", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T10:00:00Z"));
      const s = setup(1, 2); // L1, cap L2 — climbs to L2, then gets cut back
      await s.controller.ensureLoaded();
      // Calm and a raise to L2, then a rising meter so the raise's own jump debit
      // absorbs and its settle window clears — leaving ONLY the cut below to owe.
      for (let i = 0; i < 40 && s.a.generatorMode !== 2; i++) await s.feed(3.0);
      expect(s.a.generatorMode, "raise never shipped").toBe(2);
      for (let i = 0; i < 8 && s.mode() !== "NORMAL"; i++) await s.feed(6.0);
      expect(s.mode()).toBe("NORMAL");
      // A single over-limit push — the reducer cuts L2→L1.
      let cutAt = 0;
      for (let i = 0; i < 12 && cutAt === 0; i++) {
        await s.feed(16.0);
        if (s.a.generatorMode === 1) cutAt = Date.now();
      }
      expect(cutAt, "cut never shipped").toBeGreaterThan(0);
      // The meter stays high — the cut's fall has NOT reached the meter, so
      // `commandedCutTotalAmps` is still owed and the window may not exit early.
      for (let i = 0; i < 3; i++) await s.feed(14.6); // under the limit (no new cut), above the cut's landing
      expect(s.mode()).toBe("SETTLING");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-08-31 FUNDED SPEND, shell half (user: "when there is a budget because of
// another AC off or level down, it should act instantly based on prediction to
// turn on an offed AC or level it (or its fan) up").
//
// Three things live only here, so `scenarios.test.ts` structurally cannot see
// them: the urgent-evaluation dep (the harness plans every step), the SPENDABLE
// tag each arming site puts on the credit, and the manual gen level-down credit
// (`onUserGenLevel` has no harness mirror: `pinLevel` only sets a target).
// ---------------------------------------------------------------------------
describe("LevelingControllerV2: funded spend, urgent triggers and the manual level-down credit", () => {
  const meterOf = (c: LevelingControllerV2) =>
    (c as unknown as { meterState: { source: string; pendingCut: { amps: number; spendableAmps: number } | null } }).meterState;
  const meterViewOf = (c: LevelingControllerV2) =>
    meterView((c as unknown as { meterState: MeterState }).meterState, Date.now());
  const pacingOf2 = (c: LevelingControllerV2) => (c as unknown as { pacing: PacingState }).pacing;
  const setPacing2 = (c: LevelingControllerV2, pacing: PacingState) => {
    (c as unknown as { pacing: PacingState }).pacing = pacing;
  };
  const shedBarOf2 = (c: LevelingControllerV2) =>
    (c as unknown as { shedBar: Map<string, { amps: number }> }).shedBar;
  const swapOf = (c: LevelingControllerV2) =>
    (c as unknown as { swap: { donorId: string; receiverId: string } | null }).swap;
  /**
   * Drive one batch through the executor. The planner reaches these shapes only
   * from a live trade or correction; what is under test is the executor's own
   * send/bookkeeping/abort rules.
   */
  const execute = (
    c: LevelingControllerV2,
    commands: unknown[],
    out: {
      reason: string;
      commandedCutAmps: number;
      attempts?: unknown[];
      swap?: { donorId: string; receiverId: string };
    },
  ) =>
    (
      c as unknown as {
        executeAndJournal: (
          o: unknown, view: unknown, mode: string, now: number, tcl: unknown, acs: unknown[],
        ) => Promise<void>;
        deps: LevelingDeps;
      }
    ).executeAndJournal(
      {
        commands,
        decisions: [],
        expectedDeltaAmps: 0,
        compareAfter: 0,
        severity: null,
        requiredAmps: null,
        fanHolds: {},
        attempts: out.attempts ?? [],
        fanOnly: false,
        ...out,
      },
      meterViewOf(c),
      "NORMAL",
      Date.now(),
      (c as unknown as { deps: LevelingDeps }).deps.getTclCloud(),
      [],
    );

  /**
   * `bSatisfied` parks `b` at its comfort target from the start; `bTier` lets a
   * test flip it mid-run, which is what the idle demote (invariant 8) needs: a
   * room that was hot enough to earn a level and is then satisfied for the dwell.
   */
  function setup(
    configExtra: Record<string, unknown> = {},
    opts: { bSatisfied?: boolean; slotCap?: number } = {},
  ) {
    // The over-limit bucket has fired `onUrgentLevelingNeeded` since long before
    // this feature, and it fires from `onPowerReading`, OUTSIDE the tick. Count
    // the two apart, or "the reduce side asked for a pass" reads as "the batch
    // announced freed budget".
    let inTick = false;
    let urgentInTick = 0;
    const urgent = vi.fn(() => {
      if (inTick) urgentInTick++;
    });
    const mock = createGradePool({
      priority: ["a", "b"],
      genAmpModels: { a: { baseAmps: 4.5, stepAmps: 2.4 }, b: { baseAmps: 2.5, stepAmps: 1.6 } },
      // `a` sits at a configured comfort floor of L3, so the gen-entry FLOORS
      // clamp has nothing to send and its shadow confirms where it already is.
      // Without it the clamp is in flight for the whole test and every level-down
      // below is correctly refused as "our own demote is already travelling".
      levelBoosts: { a: { minLevel: 3, outdoorAtLeastC: 0 } },
      ...configExtra,
    });
    const a = { id: "a", name: "a", power: true, generatorMode: 3, maxGeneratorLevel: 3, fanSpeed: 1 };
    const b = { id: "b", name: "b", power: true, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
    // The firmware CONFIRMS what we send (the shadow follows), so a raise the
    // leveler makes is really at that level on the next tick. Without it every
    // send stays unconfirmed and nothing downstream of a confirm can be staged.
    const failing = new Set<string>();
    const failSendsFor = (id: string) => failing.add(id);
    /** SQL fragments whose query must throw (a DB wobble after an accepted send). */
    const failingSql = new Set<string>();
    const failStore = (kind: "recordShed") => {
      if (kind === "recordShed") failingSql.add("INSERT INTO ac_leveling_shed");
    };
    const poolMock = mock.pool as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> };
    const basePoolQuery = poolMock.query.bind(poolMock);
    poolMock.query = async (sql: string, params: unknown[] = []) => {
      for (const fragment of failingSql) {
        if (sql.includes(fragment)) throw new Error("db refused");
      }
      return basePoolQuery(sql, params);
    };
    /** Every cloud call the executor actually attempted, in order. */
    const sent: Array<{ deviceId: string; kind: string }> = [];
    const tcl = () =>
      ({
        sendControl: async (id: string, cmd: string, value: number) => {
          sent.push({ deviceId: id, kind: cmd });
          if (failing.has(id)) throw new Error("cloud refused");
          if (cmd === "set_generator_mode") {
            if (id === "a") a.generatorMode = value;
            if (id === "b") b.generatorMode = value;
          }
        },
        executeAcAction: async (id: string, action: { power?: number }) => {
          sent.push({ deviceId: id, kind: `power_${action.power ?? "?"}` });
          if (failing.has(id)) throw new Error("cloud refused");
          if (id === "a") a.power = action.power === 1;
          if (id === "b") b.power = action.power === 1;
        },
      }) as never;
    const controller = new LevelingControllerV2(mock.pool, {
      ...createDeps(),
      getTclCloud: tcl,
      onUrgentLevelingNeeded: urgent,
    });
    let aTier: "full" | "satisfied" = "full";
    let bTier: "full" | "satisfied" = opts.bSatisfied === true ? "satisfied" : "full";
    /** Park a room at its comfort target, which is what the idle demote waits for. */
    const setTiers = (tier: "full" | "satisfied", which: "b" | "both" = "b") => {
      bTier = tier;
      if (which === "both") aTier = tier;
    };
    let flip = 1;
    const feed = async (genAmps: number) => {
      flip = -flip;
      controller.onPowerReading({ current_1: 0, current_2: genAmps + 0.01 * flip } as never);
      vi.advanceTimersByTime(5_000);
      const ctx = [
        {
          device: a as never,
          managed: true,
          needTier: aTier,
          needDelta: aTier === "satisfied" ? 0 : 3,
          slotGenCap: opts.slotCap ?? null,
          slotKey: null,
        },
        {
          device: b as never,
          managed: true,
          needTier: bTier,
          needDelta: bTier === "satisfied" ? 0 : 3,
          slotGenCap: opts.slotCap ?? null,
          slotKey: null,
        },
      ];
      inTick = true;
      try {
        await controller.tick(ctx as never, 30);
      } finally {
        inTick = false;
      }
    };
    const run = async (genAmps: number, steps: number) => {
      for (let i = 0; i < steps; i++) await feed(genAmps);
    };
    return {
      controller,
      urgent,
      /** Urgent evaluations asked for by a BATCH, not by the over-limit bucket. */
      urgentFromBatch: () => urgentInTick,
      resetUrgentFromBatch: () => {
        urgentInTick = 0;
      },
      /** Every urgent evaluation, for the hooks that run outside a tick. */
      urgentCalls: () => urgent.mock.calls.length,
      resetUrgentFromCall: () => {
        urgent.mockClear();
      },
      a,
      b,
      feed,
      run,
      setTiers,
      failSendsFor,
      failStore,
      sent,
      mock,
    };
  }

  it("an OBSERVED off evaluates once: a deduped re-observation frees nothing new", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      const { controller, urgent, a, run } = setup();
      await controller.ensureLoaded();
      await run(12.0, 8);
      urgent.mockClear();
      a.power = false; // a remote, an automation, a hand
      await run(12.0, 1);
      expect(urgent).toHaveBeenCalledTimes(1);
      // The device poll keeps reading the same OFF shadow: `creditRoomOff` dedupes
      // it, so nothing new is freed and nothing new is evaluated.
      await run(12.0, 3);
      expect(urgent, "one physical off, one urgent evaluation").toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an over-limit reduction credits the meter but frees NOTHING a spender may take", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      const { controller, run, urgentFromBatch, resetUrgentFromBatch } = setup();
      await controller.ensureLoaded();
      await run(12.0, 8);
      resetUrgentFromBatch();
      // Push it over: the ladder cuts and credits the meter.
      await run(16.5, 10);
      const cut = meterOf(controller).pendingCut!;
      expect(cut.amps).toBeGreaterThan(0);
      expect(cut.spendableAmps, "those amps belong to the breaker").toBe(0);
      // …and the BATCH announces no freed budget: the extra pass could buy
      // nothing, and a "Budget freed" line seconds after an emergency cut would
      // tell the next forensic session the opposite of what happened. (The
      // drained bucket still asks for its own pass, from the ingest side, and that
      // trigger predates this feature and is untouched.)
      expect(urgentFromBatch(), "an emergency cut is not a budget-freed event").toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an idle DEMOTE frees spendable budget and evaluates on the spot", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      // `b` (no boost) is hot enough to earn a level on a quiet line, and then
      // satisfied: the "loaded spring" the idle demote reclaims (invariant 8).
      // An OBSERVED jump could not stage it: the controller reads one as a manual
      // target, and manual wins, so `ceilOf` would never fall below it.
      const { controller, b, run, setTiers, urgentFromBatch, resetUrgentFromBatch } = setup();
      await controller.ensureLoaded();
      await run(8.0, 20); // calm → the raise path takes b to L2, confirmed
      expect(b.generatorMode, "b earned a level").toBeGreaterThan(1);
      setTiers("satisfied");
      resetUrgentFromBatch();
      await run(8.0, 40); // past DEMOTE_DWELL_MS (120s) with a quiet line
      const cut = meterOf(controller).pendingCut;
      expect(cut, "the idle demote shipped and credited").not.toBeNull();
      expect(cut!.spendableAmps, "dormant capacity is the spender's to take").toBeGreaterThan(0);
      expect(urgentFromBatch(), "…and it is evaluated on the spot").toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a manual level-DOWN credits the model delta from the lowest COMMITTED level and evaluates", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      const { controller, urgent, run } = setup();
      await controller.ensureLoaded();
      await run(12.0, 8);
      urgent.mockClear();
      // `a` is confirmed at L3 (model 4.5 + 2×2.4 = 9.3A); pinned to L1 (4.5A)
      // that is 4.8A of freed budget, priced exactly as `modelCutAmps` prices a
      // demote: one mechanism, invariant 11.
      const res = await controller.onUserGenLevel("a", 1);
      expect(res).toEqual({ reverted: false, level: 1 });
      const cut = meterOf(controller).pendingCut!;
      expect(cut.amps).toBeCloseTo(4.8, 5);
      expect(cut.spendableAmps).toBeCloseTo(4.8, 5);
      expect(urgent).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a manual level INCREASE arms nothing", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      const { controller, urgent, run } = setup();
      await controller.ensureLoaded();
      await run(12.0, 8);
      urgent.mockClear();
      await controller.onUserGenLevel("b", 2); // b is confirmed at L1
      expect(meterOf(controller).pendingCut).toBeNull();
      expect(urgent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT credit a level our own demote is already taking (one credit path, invariant 11)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      const { controller, run } = setup();
      await controller.ensureLoaded();
      await run(12.0, 8);
      // Same tap twice: the first records the send, so the second sees OUR L1
      // still unconfirmed in `sendCounts` and adds nothing (a repeat tap credits
      // the same physical fall a second time otherwise).
      await controller.onUserGenLevel("a", 1);
      const first = meterOf(controller).pendingCut!.amps;
      await controller.onUserGenLevel("a", 1);
      expect(meterOf(controller).pendingCut!.amps).toBeCloseTo(first, 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a power-off whose send FAILS credits nothing at all", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      // The tap has to record intent BEFORE the cloud send (a fast shadow poll
      // must not turn the unit back on), so it only snapshots the level the off
      // would free. When the send throws the route never calls the promote hook,
      // and both halves of the credit stay unarmed: no spender can be funded
      // against amps still on the line, and the reducer is not discounting a
      // saving that is not coming either.
      const { controller, run, urgentCalls, resetUrgentFromCall } = setup();
      await controller.ensureLoaded();
      await run(12.0, 8);
      resetUrgentFromCall();

      await controller.onUserPowerOff("a"); // the route's pre-send hook, then the send throws

      expect(meterOf(controller).pendingCut, "nothing credited before the send lands").toBeNull();
      expect(meterViewOf(controller).spendableCreditAmps).toBe(0);
      expect(meterViewOf(controller).commandedCutCreditAmps).toBe(0);
      expect(urgentCalls(), "and nothing evaluated on a send that never left").toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("…and the same off credits + evaluates the moment the cloud ACCEPTS it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      const { controller, run, urgentCalls, resetUrgentFromCall } = setup();
      await controller.ensureLoaded();
      await run(12.0, 8);
      await controller.onUserPowerOff("a");
      resetUrgentFromCall();

      controller.onUserPowerOffSent("a"); // the route's post-send hook

      const cut = meterOf(controller).pendingCut!;
      // `a` was confirmed at L3 (model 4.5 + 2×2.4): the whole room's draw.
      expect(cut.amps).toBeCloseTo(9.3, 5);
      expect(cut.spendableAmps, "an off frees budget the limit never asked for").toBeCloseTo(9.3, 5);
      expect(urgentCalls(), "evaluated on the spot").toBeGreaterThan(0);
      // The snapshot is consumed: a second call cannot credit the same off twice
      // (the device poll's own re-observation is deduped the same way).
      controller.onUserPowerOffSent("a");
      expect(meterOf(controller).pendingCut!.amps).toBeCloseTo(9.3, 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a PARTIALLY sent batch credits only what actually shipped", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      // `sentAny` is a coarse gate: a two-cut batch whose second send throws used
      // to credit BOTH, telling the meter to expect a fall half of which will
      // never happen, and, since 2026-08-31, offering a spender amps that are
      // still on the line.
      // No boost here, so both rooms enter at their floor, climb on a quiet line,
      // and are then satisfied: one idle-demote batch carrying TWO cuts.
      const { controller, a, b, run, setTiers, failSendsFor } = setup({ levelBoosts: {} });
      await controller.ensureLoaded();
      await run(6.0, 30);
      expect(a.generatorMode, "a earned a level").toBeGreaterThan(1);
      expect(b.generatorMode, "b earned a level").toBeGreaterThan(1);
      const aFrom = a.generatorMode;
      setTiers("satisfied", "both");
      failSendsFor("b"); // the cloud refuses b's demote
      await run(6.0, 40);
      const cut = meterOf(controller).pendingCut;
      expect(cut, "the demote batch shipped").not.toBeNull();
      // Only a's cut landed. Its model delta is 2.4A per step (4.5 base / 2.4
      // step); b's 1.6A never left, so it may not be credited.
      const aOnly = 2.4 * (aFrom - 1);
      expect(cut!.amps, "only the sent command's price").toBeCloseTo(aOnly, 5);
      expect(b.generatorMode, "b never moved").toBeGreaterThan(1);
      // …and no state transition may treat the refused command as shipped.
      // Invariant 30's own ⚠ ("stamp only donors whose demote was actually
      // sent"): a room whose demote the cloud refused donated nothing, so it may
      // not be barred from its own level for the funding cooldown.
      const funding = (c: LevelingControllerV2) =>
        (c as unknown as { fundingDemotedAt: Map<string, number> }).fundingDemotedAt;
      expect(funding(controller).has("b"), "a refused demote is not a donation").toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed cut ABORTS the load-adding half of its own batch", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      // A batch is one arithmetic (invariants 9/69): the proactive shed's donor
      // off pays for the receiver's turn-on in the SAME command list. If the
      // cloud refuses the donor, the budget the receiver was admitted against
      // does not exist, and repricing the credit after the loop is too late for a
      // compressor already commanded on.
      //
      // Driven through `executeAndJournal` directly: the planner reaches this
      // shape only from a live trade, and what is under test is the executor's
      // own dependency rule, not the trade that produced the batch.
      const { controller, a, b, run, failSendsFor, sent } = setup({ levelBoosts: {} });
      await controller.ensureLoaded();
      await run(12.0, 8);
      failSendsFor("a"); // the donor's off is refused
      sent.length = 0;
      const batch = [
        { deviceId: "a", kind: "power_off" as const, reason: "shed" as const },
        { deviceId: "b", kind: "power_on" as const, level: 1, reason: "restore" as const, fan: 1 },
      ];
      await execute(controller, batch, {
        reason: "proactive_shed",
        commandedCutAmps: 4.5,
        attempts: [{ deviceId: "b", kind: "restore" }],
      });
      expect(sent.some((c) => c.deviceId === "a"), "the donor off was attempted").toBe(true);
      expect(
        sent.some((c) => c.deviceId === "b"),
        "the receiver's turn-on must NOT ship on budget the refused cut never freed",
      ).toBe(false);
      expect(b.power, "…and the device was never told to come on").toBe(true);
      expect(a.power).toBe(true);
      // (Nothing shipped at all here, so the executor returns before pacing runs;
      // the attempt bookkeeping is pinned by the REFUSED-receiver test below,
      // which is the same claim with one command through.)
    } finally {
      vi.useRealTimers();
    }
  });

  it("a restore that never SHIPPED is not recorded as an attempt", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      // The trade's donor off ships and the receiver's turn-on is refused. An
      // attempt is a claim that a command is IN FLIGHT: it parks the room behind
      // `RESTORE_CONFIRM_WAIT_MS`, and `noteSuccess` later resolves it by
      // clearing the backoff ladder and invariant 22's probe anchor. Recording
      // one for a command the cloud never took does both halves of the damage.
      const { controller, run, failSendsFor, sent } = setup({ levelBoosts: {} });
      await controller.ensureLoaded();
      await run(12.0, 8);
      // `b` carries real history: one failed restore that bounced.
      setPacing2(controller, noteFailure(pacingOf2(controller), "b", "restore", Date.now(), true));
      failSendsFor("b");
      sent.length = 0;
      const batch = [
        { deviceId: "a", kind: "power_off" as const, reason: "shed" as const },
        { deviceId: "b", kind: "power_on" as const, level: 1, reason: "restore" as const, fan: 1 },
      ];
      await execute(controller, batch, {
        reason: "proactive_shed",
        commandedCutAmps: 9.3,
        attempts: [{ deviceId: "b", kind: "restore" }],
        swap: { donorId: "a", receiverId: "b" },
      });
      expect(sent.some((c) => c.deviceId === "b"), "the receiver's send was attempted and refused").toBe(true);
      expect(
        attemptedWithin(pacingOf2(controller), "b", "restore", 60_000, Date.now()),
        "a refused restore is not an attempt",
      ).toBe(false);
      // The donor's off DID ship, so it is credited as usual…
      expect(meterOf(controller).pendingCut?.amps).toBeCloseTo(9.3, 5);
      // …and the DONOR's reservation still arms: that is the failed-send case the
      // swap is documented for (SKILL 57/69): the donor's room really is off and
      // its amps are spoken for until the receiver returns.
      expect(swapOf(controller)).toMatchObject({ donorId: "a", receiverId: "b" });

      // The other half of the same claim: the grading window must not resolve the
      // unsent restore later. `journalGrade` calls `noteSuccess` on whatever
      // attempts its window carries, and that clears the room's real failures,
      // its bounce count and invariant 22's probe anchor.
      expect(restoreFailures(pacingOf2(controller), "b")).toBe(1);
      expect(restoreBounces(pacingOf2(controller), "b")).toBe(1);
      await run(12.0, 12); // past GRADE_FAN_MS, so the window is due and grades
      expect(
        restoreFailures(pacingOf2(controller), "b"),
        "a command nobody sent may not be graded a success",
      ).toBe(1);
      expect(restoreBounces(pacingOf2(controller), "b")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refused DONOR off arms no swap reservation and leaves no shed bar", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      // The shape that keeps `sentAny` true while the trade itself never happened:
      // a correction ships, the donor's off is refused, and the receiver's turn-on
      // is skipped by the abort. Reserving the donor's amps here would park raises
      // and fan restores for `SWAP_RESERVATION_MS` on a room that is still
      // running, and a bar off a planned-but-refused off would make that room's
      // own restore clear a trough that was never dug.
      const { controller, run, failSendsFor, sent } = setup({ levelBoosts: {} });
      await controller.ensureLoaded();
      await run(12.0, 8);
      failSendsFor("a");
      sent.length = 0;
      const batch = [
        { deviceId: "b", kind: "set_level" as const, level: 1 }, // correction, ships
        { deviceId: "a", kind: "power_off" as const, reason: "shed" as const }, // refused
        { deviceId: "b", kind: "power_on" as const, level: 1, reason: "restore" as const, fan: 1 },
      ];
      await execute(controller, batch, {
        reason: "proactive_shed",
        commandedCutAmps: 9.3,
        attempts: [{ deviceId: "b", kind: "restore" }],
        swap: { donorId: "a", receiverId: "b" },
      });
      expect(sent.some((c) => c.deviceId === "b" && c.kind === "set_generator_mode"), "the correction shipped").toBe(true);
      expect(swapOf(controller), "no trade is in flight to reserve for").toBeNull();
      expect(shedBarOf2(controller).has("a"), "a refused off digs no trough").toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the abort never skips a level-0 RECAP: hard rule 5 outranks the batch arithmetic", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      // Level 0 is UNRESTRICTED draw, priced as the TOP level everywhere else, so
      // the never-level-0 correction is a REMOVAL. Read numerically it looks like
      // 0 → L1 = adding, and the abort would leave a managed AC unrestricted on a
      // generator: the one state hard rule 5 forbids outright.
      const { controller, run, failSendsFor, sent } = setup({ levelBoosts: {} });
      await controller.ensureLoaded();
      await run(12.0, 8);
      // `b` reads UNRESTRICTED. Set on the reconciler directly: the tick's own
      // never-level-0 correction would re-cap it before a synthetic batch could
      // ever see the state this test is about.
      const recon = (controller as unknown as { recon: Record<string, { confirmedLevel: number | null }> }).recon;
      (controller as unknown as { recon: unknown }).recon = {
        ...recon,
        b: { ...recon.b, confirmedLevel: 0 },
      };
      failSendsFor("a");
      sent.length = 0;
      const batch = [
        { deviceId: "a", kind: "set_level" as const, level: 1 },
        { deviceId: "b", kind: "set_level" as const, level: 1 },
      ];
      await execute(controller, batch, { reason: "over_mild", commandedCutAmps: 2.4 });
      expect(sent.some((c) => c.deviceId === "a"), "the peer cut was attempted").toBe(true);
      expect(
        sent.some((c) => c.deviceId === "b"),
        "the level-0 recap must ship even after a refused cut",
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a bookkeeping failure after an ACCEPTED send still counts the command as sent", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      // The cloud took the off; `recordShed`'s INSERT then threw. Classifying
      // that as a refusal credits nothing, aborts the rest of the batch, and
      // leaves a real commanded cliff unexplained, which is how a shed we sent
      // latches a phantom collapse (invariant 5).
      const { controller, run, sent, failStore } = setup({ levelBoosts: {} });
      await controller.ensureLoaded();
      await run(12.0, 8);
      failStore("recordShed");
      sent.length = 0;
      const batch = [
        { deviceId: "a", kind: "power_off" as const, reason: "shed" as const },
        { deviceId: "b", kind: "power_on" as const, level: 1, reason: "restore" as const, fan: 1 },
      ];
      await execute(controller, batch, { reason: "proactive_shed", commandedCutAmps: 9.3 });
      // Credited: the amps really are leaving the line.
      expect(meterOf(controller).pendingCut?.amps).toBeCloseTo(9.3, 5);
      // …and the batch was NOT aborted: the send succeeded, so the receiver ships.
      expect(sent.some((c) => c.deviceId === "b"), "the accepted off did not abort the batch").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("…but a failed cut never stops the REST of the cuts (skipping relief is the unsafe direction)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      // Both rooms park at L2 (one cuttable step each), so a 2.9A deficit needs
      // BOTH cuts: `a` alone gives 2.4A. It stays under the 3.0A emergency bar,
      // so the rung is level cuts and no room is shed.
      const { controller, a, b, run, failSendsFor } = setup({ levelBoosts: {} }, { slotCap: 2 });
      await controller.ensureLoaded();
      await run(6.0, 30); // both rooms climb above their floors
      expect(a.generatorMode).toBe(2);
      expect(b.generatorMode).toBe(2);
      failSendsFor("a"); // the cloud refuses the first cut
      const bBefore = b.generatorMode;
      await run(17.8, 20);
      expect(a.generatorMode, "the refused cut did not land").toBeGreaterThan(1);
      expect(b.generatorMode, "the other cut still shipped").toBeLessThan(bBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prices from the LOWEST committed level, so an in-flight demote's portion is not credited twice", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
      // The shape: `a` confirmed at L3, OUR OWN demote to L2 still in flight (it
      // credited model(3→2) = 2.4A when that batch shipped), and the user then
      // pins L1 by hand. Priced at the envelope's worst case the manual credit
      // would be model(3→1) = 4.8A on top of that: the same 3→2 fall counted
      // twice, invariant 31's laundering direction. From the lowest COMMITTED
      // level it is model(2→1) = 2.4A, and the two add up to the true 3→1.
      const { controller, run } = setup();
      await controller.ensureLoaded();
      await run(12.0, 8);
      const recon = (c: LevelingControllerV2) =>
        (c as unknown as { recon: Record<string, { confirmedLevel: number | null }> }).recon;
      expect(recon(controller).a.confirmedLevel, "a is confirmed at L3").toBe(3);
      // Our demote to L2 goes out and is not confirmed (the firmware lags).
      (controller as unknown as { recon: unknown }).recon = noteLevelSend(
        recon(controller) as never,
        "a",
        2,
        Date.now(),
      ).state;
      const res = await controller.onUserGenLevel("a", 1);
      expect(res).toEqual({ reverted: false, level: 1 });
      const cut = meterOf(controller).pendingCut!;
      expect(cut.amps, "only the remaining L2→L1 delta").toBeCloseTo(2.4, 5);
      expect(cut.spendableAmps).toBeCloseTo(2.4, 5);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Manual intent LIFETIME (2026-09-05, user: "a manual set of the AC level
// should be reset on the next power cycle or on the next automation range-slot
// boundary. The same rule should hold for fan speed and swing.").
//
// All of it is shell-side and structurally invisible to `scenarios.test.ts`:
// the harness has no slot keys, no beep-reset fingerprint and no pin release
// (`pinLevel` is a sim input, not a hook), so this file is the only net.
// ---------------------------------------------------------------------------
describe("LevelingControllerV2: manual intent lifetime", () => {
  /** Every emitted spelling of a power event, against the shared predicate. */
  describe("the emitter table", () => {
    it("classifies every kind this controller actually emits", () => {
      // The five spellings that reach `notePowerEvent`: `source ${from} → ${to}`,
      // `power collapse on ${source}`, `AC circuit dead on ${source}`,
      // `ESP gap ${n}s` and `meter frozen`.
      for (const kind of [
        "source gen → grid",
        "source grid → gen",
        "source gen → none", // a dark house IS a power cycle (both lines read ~0 A)
        "power collapse on gen",
        "AC circuit dead on gen",
      ]) {
        expect(powerEventRestartsAcs(kind), kind).toBe(true);
      }
      for (const kind of ["source none → grid", "source none → gen", "ESP gap 24s", "meter frozen"]) {
        // A boot restarted the SERVER, and a meter blip says nothing about the
        // line: since the CT02 switch those arrive routinely (2026-08-31).
        expect(powerEventRestartsAcs(kind), kind).toBe(false);
      }
    });
  });

  type PinState = {
    manualCap: Map<string, number>;
    manualTarget: Map<string, number>;
    fanExempt: Set<string>;
    lastSlotKey: Map<string, string>;
    lastPowerEventAt: number;
    lastAcRestartAt: number;
    devicePowerCycleAt: Map<string, number>;
    powerEventRamp: Map<string, { armedAt: number; heldSince: number | null }>;
    rampUntil: Map<string, number>;
    startBaseline: Map<string, { amps: number; until: number }>;
    externalOnAt: Map<string, number>;
    pendingGrades: Array<{ contaminated: boolean; direction: string }>;
    fanHolds: FanHolds;
    recon: ReconcilerState;
    meterState: MeterState & { pendingCut: { amps: number; spendableAmps: number } | null };
    modeState: ModeState;
    pacing: PacingState;
    inPowerEventWindow: (now: number, deviceId?: string) => boolean;
  };
  const state = (c: LevelingControllerV2) => c as unknown as PinState;

  /** Every `manual intent released` decision the journal carries, in order. */
  const releases = (journal: Array<Record<string, unknown>>) =>
    journal.flatMap((row) =>
      (JSON.parse(String(row.decisions ?? "[]")) as Array<{ action?: string; deviceId?: string; detail?: string }>)
        .filter((d) => d.action === "manual intent released")
        .map((d) => ({ ...d, reason: String(row.reason) })),
    );

  /**
   * Two managed rooms on a 15 A generator, both at L1, both hot. The amp models
   * are deliberately expensive (2.5 A a step): at the 13 A these tests feed, no
   * raise fits, so the ladder is quiet and what moves a level is a hand or an
   * entry policy, which is exactly what is under test.
   */
  function setup(configExtra: Record<string, unknown> = {}, shedIds: string[] = []) {
    const urgent = vi.fn();
    const events: Array<{ kind: string; now: number; pinsHeld: number }> = [];
    const mock = createGradePool(
      {
        priority: ["a", "b"],
        genAmpModels: { a: { baseAmps: 2.5, stepAmps: 2.5 }, b: { baseAmps: 2.5, stepAmps: 2.5 } },
        gridAmpModels: { a: { baseAmps: 2.5, stepAmps: 2.5 }, b: { baseAmps: 2.5, stepAmps: 2.5 } },
        // A calm gate no test run is long enough to satisfy: the RAISE phase
        // stays out of the way (entry policies and hands still act), so what
        // moves a level here is only what is under test.
        raiseCalmSeconds: 600,
        restoreCalmSeconds: 600,
        ...configExtra,
      },
      shedIds,
    );
    const a = { id: "a", name: "a", power: true, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
    const b = { id: "b", name: "b", power: true, generatorMode: 1, maxGeneratorLevel: 3, fanSpeed: 1 };
    const devices = [a, b];
    const sent: Array<{ deviceId: string; kind: string; value?: number }> = [];
    const tcl = () =>
      ({
        sendControl: async (id: string, cmd: string, value: number) => {
          sent.push({ deviceId: id, kind: cmd, value });
          const d = devices.find((x) => x.id === id);
          if (d == null) return;
          if (cmd === "set_generator_mode") d.generatorMode = value; // the shadow follows
          if (cmd === "set_fan_speed") d.fanSpeed = value;
        },
        executeAcAction: async (id: string, action: { power?: number }) => {
          sent.push({ deviceId: id, kind: `power_${action.power ?? "?"}` });
          const d = devices.find((x) => x.id === id);
          if (d != null && action.power != null) d.power = action.power === 1;
        },
      }) as never;
    let controller: LevelingControllerV2;
    controller = new LevelingControllerV2(mock.pool, {
      ...createDeps(),
      getTclCloud: tcl,
      onUrgentLevelingNeeded: urgent,
      onPowerEvent: (kind: string, now: number) => {
        // What the collector sees AT the callback: the controller must have
        // finished its own release before anything outward runs.
        events.push({ kind, now, pinsHeld: state(controller).manualCap.size + state(controller).manualTarget.size });
      },
    });
    /** Per-device `slotKey` and `slotGenCap` for the next tick's context. */
    const slotKeys = new Map<string, string | null>([
      ["a", null],
      ["b", null],
    ]);
    const slotCaps = new Map<string, number | null>();
    const ctxOf = () =>
      devices.map((d) => ({
        device: d as never,
        managed: true,
        needTier: "full" as const,
        needDelta: 3,
        slotGenCap: slotCaps.get(d.id) ?? null,
        slotKey: slotKeys.get(d.id) ?? null,
      }));
    let flip = 1;
    const feed = async (amps: number, opts: { grid?: boolean } = {}) => {
      flip = -flip;
      const jitter = 0.01 * flip;
      controller.onPowerReading(
        (opts.grid === true
          ? { current_1: amps + jitter, current_2: 0 }
          : { current_1: 0, current_2: amps + jitter }) as never,
      );
      vi.advanceTimersByTime(5_000);
      await controller.tick(ctxOf(), 30);
    };
    const run = async (amps: number, steps: number, opts: { grid?: boolean } = {}) => {
      for (let i = 0; i < steps; i++) await feed(amps, opts);
    };
    return { controller, mock, a, b, devices, sent, feed, run, ctxOf, slotKeys, slotCaps, events, urgent };
  }

  /** Warm up on gen, then pin `a` UP to L3 by hand (a `manualTarget`). */
  async function pinnedOnGen(configExtra: Record<string, unknown> = {}) {
    const s = setup(configExtra);
    await s.controller.ensureLoaded();
    await s.run(8.0, 6);
    const res = await s.controller.onUserGenLevel("a", 3);
    expect(res, "the pin must stand, or the test is measuring a revert").toEqual({ reverted: false, level: 3 });
    expect(state(s.controller).manualTarget.get("a")).toBe(3);
    return s;
  }

  /**
   * Warm up, let `a` confirm at L3, then take it DOWN by hand: a reduction is
   * what mints a `manualCap`, and every other test in this suite pins a target.
   */
  async function cappedOnGen(slotKey: string | null = null) {
    const s = setup();
    await s.controller.ensureLoaded();
    if (slotKey != null) {
      s.slotKeys.set("a", slotKey);
      s.slotKeys.set("b", slotKey);
    }
    await s.run(8.0, 6);
    await s.controller.onUserGenLevel("a", 3);
    s.a.generatorMode = 3; // the shadow follows the send the route made
    await s.feed(8.0);
    expect(state(s.controller).recon.a.confirmedLevel, "L3 confirmed").toBe(3);
    const res = await s.controller.onUserGenLevel("a", 1);
    expect(res).toEqual({ reverted: false, level: 1 });
    expect(state(s.controller).manualCap.get("a")).toBe(1);
    expect(state(s.controller).manualTarget.size).toBe(0);
    return s;
  }

  // A cap is the other half of "manual wins" (a hand-set CEILING), and it has
  // the same life as a target: the plan releases all three intents together, so
  // every edge is asserted on a real cap too.
  describe("a hand-set CAP lives exactly as long as a target", () => {
    it("a real changeover releases it, on the changeover's own row", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const s = await cappedOnGen();

        await s.run(8.0, 3, { grid: true });

        expect(state(s.controller).manualCap.size).toBe(0);
        const rows = releases(s.mock.journal);
        expect(rows).toHaveLength(1);
        expect(rows[0].reason).toBe("source_change");
        expect(rows[0].detail).toContain("cap L1");
      } finally {
        vi.useRealTimers();
      }
    });

    it("a slot boundary releases it", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const s = await cappedOnGen("1:A");
        s.slotKeys.set("a", "1:B");

        await s.feed(8.0);

        expect(state(s.controller).manualCap.size).toBe(0);
        const rows = releases(s.mock.journal);
        expect(rows).toHaveLength(1);
        expect(rows[0].reason).toBe("manual_release");
        expect(rows[0].detail).toContain("cap L1");
      } finally {
        vi.useRealTimers();
      }
    });

    it("a beep-reset fingerprint releases it", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const s = await cappedOnGen();

        s.controller.onDevicePowerCycle("a", "beep reset observed (power-loss restart)", Date.now());

        expect(state(s.controller).manualCap.size).toBe(0);
        const rows = releases(s.mock.journal);
        expect(rows).toHaveLength(1);
        expect(rows[0].reason).toBe("manual_release");
        expect(rows[0].detail).toContain("cap L1");
      } finally {
        vi.useRealTimers();
      }
    });

    it("an observed off releases it", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const s = await cappedOnGen();

        s.a.power = false;
        await s.feed(8.0);

        expect(state(s.controller).manualCap.size).toBe(0);
        const rows = releases(s.mock.journal);
        expect(rows).toHaveLength(1);
        expect(rows[0].detail).toContain("cap L1");
        expect(rows[0].detail).toContain("power off (observed)");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("power-cycle edge", () => {
    it("releases the pin on a gen entry AND on a grid entry, journalled on the changeover's own row", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const { controller, mock, run } = await pinnedOnGen();

        await run(8.0, 3, { grid: true }); // gen → grid, a REAL changeover

        expect(state(controller).manualTarget.size).toBe(0);
        const rows = releases(mock.journal);
        expect(rows).toHaveLength(1);
        // One row for the whole changeover, not a second one a millisecond later.
        expect(rows[0].reason).toBe("source_change");
        expect(rows[0].deviceId).toBe("a");
        expect(rows[0].detail).toContain("target L3");
      } finally {
        vi.useRealTimers();
      }
    });

    it("…and the same in the other direction: a grid→gen changeover is not special", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        // The 2026-06-09 decision kept caps across grid→gen; superseded by the
        // user on 2026-09-05, because that changeover power-cycles the units too.
        const s = setup();
        await s.controller.ensureLoaded();
        await s.run(8.0, 6, { grid: true });
        await s.controller.onUserGenLevel("a", 3);
        expect(state(s.controller).manualTarget.get("a")).toBe(3);

        await s.run(8.0, 3);

        expect(state(s.controller).manualTarget.size).toBe(0);
        expect(releases(s.mock.journal)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a boot (source none → X) and a bare meter gap release nothing", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const { controller, mock, feed, run } = await pinnedOnGen();
        // The boot event already happened on the first reading above (none → gen)
        // and the pin was made after it; a gap now must not eat it either.
        vi.advanceTimersByTime(25_000); // > ESP_GAP_EVENT_MS
        await feed(8.0);
        await run(8.0, 2);

        expect(state(controller).manualTarget.get("a")).toBe(3);
        expect(releases(mock.journal)).toHaveLength(0);
        // The classification window still opened (hard rule 2), but the RESTART
        // clock the spend gate reads did not.
        expect(state(controller).lastPowerEventAt).toBeGreaterThan(0);
        expect(state(controller).lastAcRestartAt).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a pin made BEFORE the first reading survives the boot event that follows it", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        // The boot delivery ("source none → gen") is the one event that arrives
        // with intent already on the books after a deploy: the leveler's source
        // also falls back to "none" after a long meter outage, so this is a live
        // shape, not just a cold start.
        const s = setup();
        await s.controller.ensureLoaded();
        await s.controller.onUserGenLevel("a", 3); // no baseline yet, so a cap
        expect(state(s.controller).manualCap.get("a")).toBe(3);

        await s.feed(8.0); // the first reading: none → gen

        expect(state(s.controller).manualCap.get("a"), "only the SERVER restarted").toBe(3);
        expect(state(s.controller).lastAcRestartAt).toBe(0);
        expect(releases(s.mock.journal)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stamps its own clock and releases BEFORE it calls out, on the timestamp it passes", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const { controller, events, run } = await pinnedOnGen();
        events.length = 0;

        await run(8.0, 3, { grid: true });

        const change = events.find((e) => e.kind.startsWith("source gen"));
        expect(change, "the changeover reached the collector").toBeDefined();
        expect(change!.now, "one clock: the stamp is the timestamp handed over").toBe(
          state(controller).lastPowerEventAt,
        );
        expect(change!.pinsHeld, "our own state is finished before anything outward runs").toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a collector that re-enters us from that callback still releases exactly once", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        // The collector's fan/swing wipe runs inside `onPowerEvent`, and its
        // beep-reset site calls straight back into this controller. A half-done
        // release would either double-journal or lose the unconfirmed sends.
        const s = setup();
        await s.controller.ensureLoaded();
        await s.run(8.0, 6);
        await s.controller.onUserGenLevel("a", 3);
        const inFlight = unconfirmedLevels(state(s.controller).recon, "a", Date.now());
        expect(inFlight).toContain(3);
        s.events.length = 0;
        (s.controller as unknown as { deps: LevelingDeps }).deps.onPowerEvent = (kind: string, now: number) => {
          s.controller.onDevicePowerCycle("a", `re-entrant (${kind})`, now);
        };

        await s.run(8.0, 3, { grid: true });

        expect(releases(s.mock.journal)).toHaveLength(1);
        expect(state(s.controller).manualTarget.size).toBe(0);
        // Invariant 34: the send the firmware may still be sitting at survives
        // every re-baseline, or the envelope prices the room light.
        expect(unconfirmedLevels(state(s.controller).recon, "a", Date.now())).toContain(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("the beep-reset fingerprint is a physical restart", () => {
    it("does everything the OFF→ON flip does, for a unit whose shadow never showed the off", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const { controller, mock, b, run } = await pinnedOnGen();
        await controller.onUserFanChange("a"); // a fan exemption to release too
        // A live, SPENDABLE credit from a room switched off at the dashboard.
        await controller.onUserPowerOff("b");
        controller.onUserPowerOffSent("b");
        const armed = state(controller).meterState.pendingCut!;
        expect(armed.spendableAmps).toBeGreaterThan(0);
        // An open up-grade, the shape a fresh compressor contaminates.
        state(controller).pendingGrades = [{ contaminated: false, direction: "up" }];
        // The boot changeover is not what is under test here: zero the
        // house-wide clock so the per-device assertions below mean something.
        state(controller).lastPowerEventAt = 0;
        const now = Date.now();

        controller.onDevicePowerCycle("a", "beep reset observed (power-loss restart)", now);

        expect(state(controller).manualTarget.size).toBe(0);
        expect(state(controller).fanExempt.has("a")).toBe(false);
        expect(releases(mock.journal).map((r) => r.reason)).toEqual(["manual_release"]);
        // Restart protection outlasts AC_RAMP_MS, so this ramp closes on
        // evidence rather than on its timer (invariant 44).
        expect(state(controller).powerEventRamp.has("a")).toBe(true);
        expect(state(controller).rampUntil.get("a")).toBe(now + 240_000);
        expect(state(controller).startBaseline.has("a"), "a start window opened").toBe(true);
        expect(state(controller).externalOnAt.get("a")).toBe(now);
        expect(state(controller).pendingGrades[0].contaminated).toBe(true);
        // The demand side survives (the fall still has to explain itself to the
        // collapse latch); only the spend side dies.
        const after = state(controller).meterState.pendingCut!;
        expect(after.amps).toBeCloseTo(armed.amps, 5);
        expect(after.spendableAmps).toBe(0);
        // Per-device, and only per-device.
        expect(state(controller).devicePowerCycleAt.get("a")).toBe(now);
        expect(state(controller).lastPowerEventAt, "a house-wide clock this is not").toBe(0);
        expect(state(controller).lastAcRestartAt).toBe(0);
        expect(state(controller).inPowerEventWindow(now, "a")).toBe(true);
        expect(state(controller).inPowerEventWindow(now, "b")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("the first shadow after it is ADOPTED, even mid-settle, so nothing re-mints the pin", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const { controller, a, feed, run } = await pinnedOnGen();
        await controller.onUserFanChange("a");
        controller.onDevicePowerCycle("a", "beep reset observed (power-loss restart)", Date.now());
        // The firmware restores the level it was last commanded to: in the
        // shadow that is character-for-character a hand raise (the 2026-08-06
        // 07:01:52Z shape), and it arrives while the last batch is settling.
        state(controller).modeState = noteBatch(state(controller).modeState, { fanOnly: false }, Date.now());
        a.generatorMode = 3;

        await feed(8.0);

        expect(state(controller).recon.a.confirmedLevel).toBe(3);
        expect(state(controller).recon.a.adoptNextObservation).toBeFalsy();
        expect(state(controller).manualTarget.size, "no re-mint").toBe(0);
        expect(state(controller).manualCap.size).toBe(0);
        expect(state(controller).fanExempt.size).toBe(0);
        await run(8.0, 2);
        expect(state(controller).manualTarget.size).toBe(0);
        expect(state(controller).manualCap.size).toBe(0);
        expect(state(controller).fanExempt.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("an observed fan 0 under a live hold releases the hold and mints NO exemption", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const { controller, a, feed } = await pinnedOnGen();
        state(controller).fanHolds = {
          a: { deviceId: "a", originalFan: 5, lastSetFan: 1, heldAt: Date.now() },
        };
        // TCL zeroes the blower on every power-loss restart; no hold ever asks
        // for 0, so an observed 0 is the firmware, never a hand.
        a.fanSpeed = 0;

        await feed(8.0);

        expect(controller.hasFanHold("a")).toBe(false);
        expect(state(controller).fanExempt.has("a"), "one blackout must not bar the room from trimming").toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("…but an observed 0 while OUR set_fan is in flight is shadow LAG, and keeps the hold", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        // The room was on built-in auto when the hold was placed (originalFan 0)
        // and we sent it fan 1; until that send confirms, a 0 in the shadow is
        // the old state still being reported, not a restart. Releasing there
        // would kill a healthy hold on every trim we make to an auto room.
        const { controller, a, feed } = await pinnedOnGen();
        state(controller).fanHolds = {
          a: { deviceId: "a", originalFan: 0, lastSetFan: 1, heldAt: Date.now() },
        };
        state(controller).recon = noteFanSend(state(controller).recon, "a", 1, Date.now());
        a.fanSpeed = 0;

        await feed(8.0); // inside FAN_RESEND_SPACING_MS: nothing to resend yet

        expect(controller.hasFanHold("a"), "the hold survives its own send's lag").toBe(true);
        expect(state(controller).fanExempt.has("a")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("…and once that send is due for a resend, the resend goes out and the hold still stands", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const { controller, a, sent, feed } = await pinnedOnGen();
        state(controller).fanHolds = {
          a: { deviceId: "a", originalFan: 0, lastSetFan: 1, heldAt: Date.now() },
        };
        state(controller).recon = noteFanSend(state(controller).recon, "a", 1, Date.now() - 20_000);
        a.fanSpeed = 0;
        sent.length = 0;

        await feed(8.0); // past the spacing: confirm-or-resend owns this tick

        expect(sent.filter((c) => c.kind === "set_fan_speed" && c.value === 1)).toHaveLength(1);
        expect(controller.hasFanHold("a")).toBe(true);
        expect(state(controller).fanExempt.has("a")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a hold that RESTORED a room to built-in auto lands its own 0, and no reset is read into it", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        // `fan-trim` restores an originalFan-0 room with a single `set_fan 0`
        // (`lastSetFan: 0`), so a 0 in the shadow there is our own command
        // landing. That hold ends through the restore path, never here.
        const { controller, a, feed } = await pinnedOnGen();
        state(controller).fanHolds = {
          a: { deviceId: "a", originalFan: 0, lastSetFan: 0, heldAt: Date.now() },
        };
        a.fanSpeed = 0;

        await feed(8.0);

        expect(controller.hasFanHold("a"), "not released as a power_cycle_reset").toBe(true);
        expect(state(controller).fanExempt.has("a")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a dashboard change lands as a CAP while the re-baseline is pending, and is classified once it lands", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const { controller, a, feed, urgent } = await pinnedOnGen();
        controller.onDevicePowerCycle("a", "beep reset observed (power-loss restart)", Date.now());
        const cutBefore = state(controller).meterState.pendingCut;
        urgent.mockClear();

        // BEFORE the first post-reboot shadow: the baseline is the pre-reboot
        // level, so it is read as unknown and the conservative branch runs.
        const first = await controller.onUserGenLevel("a", 2);
        expect(first).toEqual({ reverted: false, level: 2 });
        expect(state(controller).manualCap.get("a")).toBe(2);
        expect(state(controller).manualTarget.size).toBe(0);
        expect(baselineStale(state(controller).recon, "a"), "the marker outlives the tap").toBe(true);
        // …and it prices NOTHING: a level-down credit needs a level to count
        // down FROM, and the only one on the books belongs to a session that
        // ended when the unit rebooted.
        expect(state(controller).meterState.pendingCut).toBe(cutBefore);
        expect(urgent, "nothing was freed, so nothing is evaluated").not.toHaveBeenCalled();

        // The shadow finally reports; the send we recorded lands through the adopt.
        a.generatorMode = 2;
        await feed(8.0);
        expect(baselineStale(state(controller).recon, "a")).toBe(false);
        expect(state(controller).recon.a.confirmedLevel).toBe(2);

        // …and NOW a raise is classified from the adopted level, as a target.
        const second = await controller.onUserGenLevel("a", 3);
        expect(second).toEqual({ reverted: false, level: 3 });
        expect(state(controller).manualTarget.get("a")).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("refactor parity: the ordinary OFF→ON flip still arms a TIMED ramp and still withholds the shield", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        // The structural-ON bookkeeping moved into `noteDevicePoweredOn`; the
        // flip must behave exactly as it did (a power-event ramp here would hold
        // the raise path open past its window on evidence it never gathered).
        const s = setup();
        await s.controller.ensureLoaded();
        s.a.power = false;
        await s.run(8.0, 4);
        s.a.power = true;
        await s.feed(8.0);
        const onAt = Date.now();

        expect(state(s.controller).powerEventRamp.has("a"), "a timed ramp, not a power-event one").toBe(false);
        expect(state(s.controller).rampUntil.get("a")).toBe(onAt + 240_000);
        expect(state(s.controller).externalOnAt.get("a"), "a bare external ON still shields").toBe(onAt);

        // A room WE restored takes the same flip and must NOT be shielded.
        const shedRoom = setup({}, ["b"]);
        await shedRoom.controller.ensureLoaded();
        shedRoom.b.power = false;
        await shedRoom.run(8.0, 4);
        shedRoom.b.power = true;
        await shedRoom.feed(8.0);
        expect(shedRoom.controller.isShed("b"), "the restore confirmed").toBe(false);
        expect(state(shedRoom.controller).externalOnAt.has("b")).toBe(false);
        expect(state(shedRoom.controller).powerEventRamp.has("b")).toBe(false);

        // …and neither is one whose restore is still in flight (the shed record
        // was already cleared by the device poll on this same ON).
        const inFlight = setup();
        await inFlight.controller.ensureLoaded();
        inFlight.b.power = false;
        await inFlight.run(8.0, 4);
        state(inFlight.controller).pacing = noteAttempt(
          state(inFlight.controller).pacing,
          "b",
          "restore",
          Date.now(),
        );
        inFlight.b.power = true;
        await inFlight.feed(8.0);
        expect(state(inFlight.controller).externalOnAt.has("b")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("entry policy after a release", () => {
    it("a gen entry clamps from the CONFIGURED floor, not from the released pin, and keeps the send charged", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        // Pin L3 on grid with the shadow still at L1 (the send is in flight),
        // then enter gen. The entry must judge the room by its CONFIGURED floor
        // and leave it at L1: a released pin is not a floor. The in-flight send
        // has to survive the re-baseline all the same (invariant 34), or the
        // envelope prices the room a whole step light.
        const s = setup();
        await s.controller.ensureLoaded();
        s.slotCaps.set("a", 1); // the slot's own hard cap keeps GRID_FULL off it
        await s.run(8.0, 6, { grid: true });
        expect(s.a.generatorMode).toBe(1);
        await s.controller.onUserGenLevel("a", 3);
        expect(state(s.controller).manualTarget.get("a")).toBe(3);
        s.slotCaps.delete("a"); // …and the slot stops capping before the entry
        s.sent.length = 0;

        await s.feed(8.0); // the changeover tick itself

        expect(state(s.controller).manualTarget.size, "gone before the tick planned").toBe(0);
        expect(unconfirmedLevels(state(s.controller).recon, "a", Date.now())).toContain(3);
        // What the pipeline was actually handed this tick: no pin, the room's
        // OWN floor, and the unconfirmed L3 still charged as the worst case the
        // firmware might be sitting at (invariant 7/34).
        const view = (
          s.controller as unknown as {
            buildViews: (
              ctx: unknown[],
              outdoorTempC: number | null,
              now: number,
            ) => Array<{ deviceId: string; manualTarget: number | null; minLevel: number; envelopeLevel: number }>;
          }
        ).buildViews(s.ctxOf(), 30, Date.now()).find((v) => v.deviceId === "a")!;
        expect(view.manualTarget).toBeNull();
        expect(view.minLevel, "judged by the configured floor").toBe(1);
        expect(view.envelopeLevel).toBe(3);
        const levels = s.sent.filter((c) => c.kind === "set_generator_mode" && c.deviceId === "a");
        expect(levels.filter((c) => (c.value ?? 0) > 1), "no level above the floor was commanded").toEqual([]);
        expect(s.a.generatorMode, "the entry does not honour a pin it just released").toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a grid entry lifts a pin-free room to its ceiling (GRID_FULL)", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const { controller, sent, run } = await pinnedOnGen();
        sent.length = 0;

        await run(8.0, 4, { grid: true });

        expect(state(controller).manualTarget.size).toBe(0);
        // 30 A of grid: "on grid, start all to full" applies to a room whose pin
        // the changeover just ended, exactly as it does to any other room.
        expect(sent.some((c) => c.kind === "set_generator_mode" && (c.value ?? 0) > 1)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("the restart window gates the SPEND side of an observed off", () => {
    it("an off inside the window credits the meter but funds nothing, and evaluates nothing", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const s = setup();
        await s.controller.ensureLoaded();
        await s.run(8.0, 6);
        const changeoverAt = Date.now();
        await s.run(8.0, 3, { grid: true }); // a REAL changeover: the restart clock
        expect(state(s.controller).lastAcRestartAt).toBe(changeoverAt);
        s.urgent.mockClear();

        s.a.power = false; // the automation is about to put it back
        await s.feed(8.0, { grid: true });

        const cut = state(s.controller).meterState.pendingCut!;
        expect(cut.amps, "the fall still has to explain itself").toBeGreaterThan(0);
        expect(cut.spendableAmps, "a power-loss off funds no raise").toBe(0);
        expect(s.urgent, "and nothing is evaluated on it").not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("the same off past the window is spendable again", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const s = setup();
        await s.controller.ensureLoaded();
        await s.run(8.0, 6);
        // 16 minutes after the restart: the units are long back.
        state(s.controller).lastAcRestartAt = Date.now() - 16 * 60_000;
        s.urgent.mockClear();

        s.a.power = false;
        await s.feed(8.0);

        expect(state(s.controller).meterState.pendingCut!.spendableAmps).toBeGreaterThan(0);
        expect(s.urgent).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a bare ESP gap leaves it spendable: the gap never stamps the restart clock", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        // The whole point of the second clock: `lastPowerEventAt` is stamped by
        // every routine CT02 blip, and keying the spend gate on it would switch
        // funded spend off most of the day.
        const s = setup();
        await s.controller.ensureLoaded();
        await s.run(8.0, 6);
        vi.advanceTimersByTime(25_000);
        const gapAt = Date.now();
        await s.feed(8.0); // "ESP gap 25s"
        expect(state(s.controller).lastPowerEventAt).toBe(gapAt);
        expect(state(s.controller).lastAcRestartAt, "a gap says nothing about the line").toBe(0);
        s.urgent.mockClear();

        s.a.power = false;
        await s.feed(8.0);

        expect(state(s.controller).meterState.pendingCut!.spendableAmps).toBeGreaterThan(0);
        expect(s.urgent).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("one room's fingerprint gates that room's off only, never its neighbour's", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const s = setup();
        await s.controller.ensureLoaded();
        await s.run(8.0, 6);
        s.controller.onDevicePowerCycle("a", "beep reset observed (power-loss restart)", Date.now());
        s.urgent.mockClear();

        s.a.power = false;
        s.b.power = false;
        await s.feed(8.0);

        const cut = state(s.controller).meterState.pendingCut!;
        // `a` is credited (2.5 A at L1) and `b` is credited AND spendable, so
        // the pool carries both while only b's amps may be spent.
        expect(cut.amps).toBeCloseTo(5.0, 5);
        expect(cut.spendableAmps).toBeCloseTo(2.5, 5);
        expect(s.urgent, "b's off is ordinary and evaluates on the spot").toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("the range-slot boundary", () => {
    /** Pin `a`, with the slot regime it was pinned under already stored. */
    async function pinnedInSlot(key: string) {
      const s = setup();
      await s.controller.ensureLoaded();
      s.slotKeys.set("a", key);
      s.slotKeys.set("b", key);
      await s.run(8.0, 6);
      await s.controller.onUserGenLevel("a", 3);
      await s.controller.onUserFanChange("a");
      expect(state(s.controller).manualTarget.get("a")).toBe(3);
      expect(state(s.controller).lastSlotKey.get("a")).toBe(key);
      return s;
    }

    it("A → B releases the pins AND the fan exemption, before the tick plans against the new cap", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const s = await pinnedInSlot("1:A");
        s.slotKeys.set("a", "1:B");
        s.slotCaps.set("a", 2);

        await s.feed(8.0);

        const view = s.controller.getStatus().acs.find((x) => x.deviceId === "a")!;
        expect(view.manualTarget).toBeNull();
        expect(view.slotCap, "the same tick already plans against the new slot").toBe(2);
        expect(state(s.controller).fanExempt.has("a")).toBe(false);
        const rows = releases(s.mock.journal);
        expect(rows).toHaveLength(1);
        expect(rows[0].reason).toBe("manual_release");
        expect(rows[0].detail).toContain("1:A → 1:B");
        expect(rows[0].detail).toContain("fan exemption");
      } finally {
        vi.useRealTimers();
      }
    });

    it("A → unknown → A releases nothing (a one-tick metric gap is not a boundary)", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const s = await pinnedInSlot("1:A");

        s.slotKeys.set("a", null);
        await s.feed(8.0);
        s.slotKeys.set("a", "1:A");
        await s.feed(8.0);

        expect(state(s.controller).manualTarget.get("a")).toBe(3);
        expect(releases(s.mock.journal)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("A → inactive → A releases exactly once", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        // "Inactive" is a KNOWN regime (the rule owes an OFF, not a threshold),
        // so entering it is a real boundary; coming back finds nothing left.
        const s = await pinnedInSlot("1:A");

        s.slotKeys.set("a", "1:inactive");
        await s.feed(8.0);
        expect(state(s.controller).manualTarget.size).toBe(0);
        s.slotKeys.set("a", "1:A");
        await s.feed(8.0);

        expect(releases(s.mock.journal)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("A → inactive → B releases too", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const s = await pinnedInSlot("1:A");

        s.slotKeys.set("a", "1:inactive");
        await s.feed(8.0);
        s.slotKeys.set("a", "1:B");
        await s.feed(8.0);

        expect(state(s.controller).manualTarget.size).toBe(0);
        expect(releases(s.mock.journal)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("boot → unknown → A does not release: recovering from an unknown regime is not a boundary", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const s = setup(); // slot keys start null, as they do after a deploy
        await s.controller.ensureLoaded();
        await s.run(8.0, 6);
        await s.controller.onUserGenLevel("a", 3);
        expect(state(s.controller).lastSlotKey.has("a")).toBe(false);

        s.slotKeys.set("a", "1:A");
        await s.feed(8.0);

        expect(state(s.controller).manualTarget.get("a"), "a pin made while unknown survives").toBe(3);
        expect(state(s.controller).lastSlotKey.get("a")).toBe("1:A");
        expect(releases(s.mock.journal)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a pin set AFTER the boundary survives until the next one", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const s = await pinnedInSlot("1:A");
        s.slotKeys.set("a", "1:B");
        await s.feed(8.0);
        expect(state(s.controller).manualTarget.size).toBe(0);

        await s.controller.onUserGenLevel("a", 3); // he pins again, under B
        await s.feed(8.0);
        expect(state(s.controller).manualTarget.get("a")).toBe(3);

        s.slotKeys.set("a", "1:C");
        await s.feed(8.0);
        expect(state(s.controller).manualTarget.size).toBe(0);
        expect(releases(s.mock.journal)).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("power-off paths", () => {
    it("an OBSERVED off clears all three, through the helper, journalled", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const { controller, mock, a, feed } = await pinnedOnGen();
        await controller.onUserFanChange("a");

        a.power = false;
        await feed(8.0);

        expect(state(controller).manualTarget.size).toBe(0);
        expect(state(controller).manualCap.size).toBe(0);
        expect(state(controller).fanExempt.has("a")).toBe(false);
        const rows = releases(mock.journal);
        expect(rows).toHaveLength(1);
        expect(rows[0].detail).toContain("power off (observed)");
      } finally {
        vi.useRealTimers();
      }
    });

    it("the DASHBOARD off still clears the level pins only: an intent is not a confirmed power cycle", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
        const { controller, mock } = await pinnedOnGen();
        await controller.onUserFanChange("a");

        await controller.onUserPowerOff("a");

        expect(state(controller).manualTarget.size).toBe(0);
        expect(state(controller).manualCap.size).toBe(0);
        // The fan exemption is the user's own, made on this same room, and this
        // path runs BEFORE the cloud send: nothing has power-cycled yet.
        expect(state(controller).fanExempt.has("a")).toBe(true);
        expect(releases(mock.journal)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
