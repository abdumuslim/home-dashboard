import { describe, it, expect, vi } from "vitest";
import { LevelingControllerV2, batchLoadDirections } from "./controller.js";
import type { LevelingDeps } from "./api.js";

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
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
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
  return { pool: { query } as never, journal, costs, levelHolds };
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
      { device: dev("cool", opts.coolTemp), managed: true, needTier: "full" as const, needDelta: opts.coolNeed, slotGenCap: null },
      { device: dev("hot", opts.hotTemp), managed: true, needTier: "full" as const, needDelta: opts.hotNeed, slotGenCap: null },
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
    ).buildViews([{ device, managed: true, needTier: "full", needDelta: 7, slotGenCap: null }], 40, Date.now());

    expect(views[0].roomTempC).toBe(34);
    // 34 − 25, the shared comfort target. Had `targetFromSetpoint` leaked into
    // the ranking this would read 7 (34 − 27) and a room would be ordering the
    // house on its own occupant's preference.
    expect(views[0].rankNeedDelta).toBe(9);
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
        { device: device as never, managed: true, needTier: "full" as const, needDelta: 2, slotGenCap: null },
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
        { device: acDevice("a", true, 3), managed: true, needTier: "full" as const, needDelta: 2, slotGenCap: null },
        { device: acDevice("b", false, 1), managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null },
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
        { device: acDevice("a", true, 3), managed: true, needTier: "full" as const, needDelta: 2, slotGenCap: null },
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
        { device: acDevice("a", true, 1), managed: true, needTier: "full" as const, needDelta: 2, slotGenCap: null },
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
        { device: acDevice("a", true, 1), managed: true, needTier: "full" as const, needDelta: 0.3, slotGenCap: null },
        { device: b as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null },
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
        { device: device as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null },
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
        { device: device as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null },
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
      const ctx = [{ device: a as never, managed: true, needTier: "full" as const, needDelta: 0.3, slotGenCap: null }];
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
        { device: a as never, managed: true, needTier: "full" as const, needDelta: 0.3, slotGenCap: null },
        { device: b as never, managed: true, needTier: "full" as const, needDelta: 0.3, slotGenCap: null },
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
        { device: acDevice("a", true, 1), managed: true, needTier: "full" as const, needDelta: 2, slotGenCap: null },
        { device: b as never, managed: true, needTier: "full" as const, needDelta: 3, slotGenCap: null },
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
      { device: abdullah, managed: true, needTier: "full", needDelta: 1.5, slotGenCap: null },
      { device: abdu, managed: true, needTier: "full", needDelta: 1.6, slotGenCap: null },
      { device: najat, managed: true, needTier: "mild", needDelta: 0.9, slotGenCap: null },
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
        { device: abdullah as never, managed: true, needTier: "mild" as const, needDelta: 0.6, slotGenCap: null },
        { device: acDevice("najat", true, 1), managed: true, needTier: "mild" as const, needDelta: 0.5, slotGenCap: null },
        { device: acDevice("abdu", true, 1), managed: true, needTier: "full" as const, needDelta: 2.4, slotGenCap: null },
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
    const ctx = [
      { device: device(HOT, opts.hotLevel ?? 2, 32), managed: true, needTier: "full" as const, needDelta: opts.hotNeed ?? 5, slotGenCap: null },
      { device: device(COOL, 1, 27), managed: true, needTier: "full" as const, needDelta: 1, slotGenCap: null },
    ];
    let flip = 1;
    const run = async (amps: number, steps: number, outdoorC: number | null) => {
      for (let i = 0; i < steps; i++) {
        flip = -flip;
        controller.onPowerReading({ current_1: 0, current_2: amps + 0.01 * flip } as never);
        vi.advanceTimersByTime(5_000);
        await controller.tick(ctx as never, outdoorC);
      }
    };
    return { mock, controller, sent, offs, run };
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
      const { mock, controller, run } = setup({ hotLevel: 1 });
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

  it("arms from the system's OWN evidence — the watch zone, three degrees before the floor", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T10:00:00Z"));
      // 37°C: inside Abdullah's watch zone (39 − 3) and BELOW his configured
      // floor, so the boost has not armed — this is exactly the window in which
      // the evidence can be gathered before the heat that makes it matter.
      const { mock, controller, run } = setup({
        hotLevel: 1,
        levelBoosts: { [HOT]: { minLevel: 2, outdoorAtLeastC: 39 } },
      });
      await controller.ensureLoaded();

      // 3 min of no cooling progress at L1 (SUBFLOOR_WATCH_MS) at a fixed need,
      // riding near the limit so the raise path cannot lift the room out of the
      // very level the evidence is about.
      await run(14.6, 45, 37);

      expect(mock.levelHolds.get(HOT)).toMatchObject({ level: 1, outdoorC: 37 });
      // …and the hold now extends the hard floor BELOW the configured 39°C bar,
      // which is the whole point of learning it.
      expect(controller.getStatus().acs.find((a) => a.deviceId === HOT)?.minLevel).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records nothing when the outdoor feed is stale — a hold with no bar is a six-hour ban", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T10:00:00Z"));
      const { mock, controller, run } = setup({
        hotLevel: 1,
        levelBoosts: { [HOT]: { minLevel: 2, outdoorAtLeastC: 39 } },
      });
      await controller.ensureLoaded();
      await run(14.6, 45, null);
      expect(mock.levelHolds.size).toBe(0);
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
    const ctx = [{ device: a as never, managed: true, needTier: "full" as const, needDelta: 0.3, slotGenCap: null }];
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
