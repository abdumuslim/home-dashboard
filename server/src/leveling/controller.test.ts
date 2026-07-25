import { describe, it, expect, vi } from "vitest";
import { LevelingControllerV2 } from "./controller.js";
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
    if (sql.includes("SELECT config FROM ac_leveling_config WHERE id = 2")) {
      return { rows: configById.has(2) ? [{ config: configById.get(2) }] : [], rowCount: configById.has(2) ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO ac_leveling_config")) {
      configById.set(2, JSON.parse(String(params[0])));
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

function createGradePool() {
  const journal: Array<Record<string, unknown>> = [];
  const costs: Array<{ deviceId: string; transition: string }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM ac_leveling_config") && sql.includes("id IN (1, 2)")) {
      return { rows: [{ id: 2, config: { controller: "v2", enabled: true, genLimitAmps: 15, marginAmps: 0.1 } }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO ac_leveling_journal")) {
      journal.push({ reason: params[4], commands: params[7] });
      return { rows: [{ id: journal.length }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO ac_leveling_costs")) {
      costs.push({ deviceId: String(params[0]), transition: String(params[2]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("COUNT(*)") && sql.includes("ac_leveling_costs")) return { rows: [{ n: 7 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as never, journal, costs };
}

function acDevice(id: string, power: boolean, generatorMode: number) {
  return { id, name: id, power, generatorMode, maxGeneratorLevel: 3, fanSpeed: 1 } as never;
}

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
});
