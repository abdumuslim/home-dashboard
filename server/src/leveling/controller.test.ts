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
