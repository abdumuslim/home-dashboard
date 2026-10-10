import { describe, it, expect, vi } from "vitest";
import { LevelingControllerV2 } from "./controller.js";
import type { LevelingDeps, LevelingStatusV2 } from "./api.js";
import {
  COLLAPSE_DERATE_MS,
  STRAIN_DERATE_MS,
  derateBreakdown,
  derateFor,
  initialMeterState,
  meterView,
  strainDerateFor,
  totalDerateFor,
} from "./sensing.js";
import type { MeterState } from "./types.js";

// 2026-09-26: the owner set a 16 A gen limit and the card said 15 A, because a
// trip derate was live and nothing on the page said so. These tests pin the
// status fields that make the derate visible without touching the derate math.

const T0 = 1_800_000_000_000;

function stateWith(patch: Partial<MeterState>): MeterState {
  return { ...initialMeterState(), ...patch };
}

describe("derateBreakdown", () => {
  it("reports nothing when no derate is standing", () => {
    expect(derateBreakdown(initialMeterState(), "gen", T0)).toEqual({ collapseAmps: 0, strainAmps: 0, clearsAt: null });
  });

  it("splits collapse and strain and agrees with the existing per-record functions", () => {
    const state = stateWith({
      derate: { source: "gen", amps: 1, until: T0 + 60_000 },
      strainDerate: { source: "gen", amps: 0.5, until: T0 + 120_000 },
    });
    const b = derateBreakdown(state, "gen", T0);
    expect(b.collapseAmps).toBe(derateFor(state, "gen", T0));
    expect(b.strainAmps).toBe(strainDerateFor(state, "gen", T0));
    expect(b.collapseAmps + b.strainAmps).toBe(totalDerateFor(state, "gen", T0));
  });

  it("ignores a record armed on the other source (per-source, like derateFor)", () => {
    const state = stateWith({ derate: { source: "grid", amps: 1, until: T0 + 60_000 } });
    expect(derateBreakdown(state, "gen", T0)).toEqual({ collapseAmps: 0, strainAmps: 0, clearsAt: null });
  });

  it("clearsAt is the first instant derateFor reaches 0 for a 1 A collapse (one more 20 min rung after until)", () => {
    const until = T0 + 60_000;
    const state = stateWith({ derate: { source: "gen", amps: 1, until } });
    const { clearsAt } = derateBreakdown(state, "gen", T0);
    expect(clearsAt).toBe(until + COLLAPSE_DERATE_MS);
    expect(derateFor(state, "gen", clearsAt! - 1)).toBeGreaterThan(0);
    expect(derateFor(state, "gen", clearsAt!)).toBe(0);
  });

  it("clearsAt for a full 3 A stack walks every 0.5 A rung", () => {
    const until = T0 + 60_000;
    const state = stateWith({ derate: { source: "gen", amps: 3, until } });
    const { clearsAt } = derateBreakdown(state, "gen", T0);
    // 3 / 0.5 = 6 steps; the first lands at `until`, the sixth 5 rungs later.
    expect(clearsAt).toBe(until + 5 * COLLAPSE_DERATE_MS);
    expect(totalDerateFor(state, "gen", clearsAt! - 1)).toBeGreaterThan(0);
    expect(totalDerateFor(state, "gen", clearsAt!)).toBe(0);
  });

  it("clearsAt is the LATER of the two records when both stand", () => {
    const state = stateWith({
      derate: { source: "gen", amps: 1, until: T0 + 60_000 },
      strainDerate: { source: "gen", amps: 1.5, until: T0 + 30_000 },
    });
    const { clearsAt } = derateBreakdown(state, "gen", T0);
    const collapseClear = T0 + 60_000 + COLLAPSE_DERATE_MS;
    const strainClear = T0 + 30_000 + 2 * STRAIN_DERATE_MS;
    expect(clearsAt).toBe(Math.max(collapseClear, strainClear));
    expect(totalDerateFor(state, "gen", clearsAt! - 1)).toBeGreaterThan(0);
    expect(totalDerateFor(state, "gen", clearsAt!)).toBe(0);
  });

  it("clearsAt accounts for rungs already handed back", () => {
    const until = T0;
    const state = stateWith({ derate: { source: "gen", amps: 1.5, until } });
    // One rung already gone: live 1.0 A, clears two rungs after `until`.
    const now = until + 1_000;
    const b = derateBreakdown(state, "gen", now);
    expect(b.collapseAmps).toBe(1);
    expect(b.clearsAt).toBe(until + 2 * COLLAPSE_DERATE_MS);
  });

  it("a fully recovered record reports nothing even though it is still stored", () => {
    const state = stateWith({ derate: { source: "gen", amps: 1, until: T0 } });
    expect(derateBreakdown(state, "gen", T0 + COLLAPSE_DERATE_MS)).toEqual({ collapseAmps: 0, strainAmps: 0, clearsAt: null });
  });
});

function createMockPool(configRow1: Record<string, unknown>) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM ac_leveling_config") && sql.includes("id IN (1, 2)")) {
      return { rows: [{ id: 1, config: configRow1 }, { id: 2, config: { controller: "v2", enabled: true } }], rowCount: 2 };
    }
    if (sql.includes("COUNT(*)") && sql.includes("ac_leveling_costs")) return { rows: [{ n: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { query } as never;
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

type BuildStatus = (
  acs: never[],
  view: ReturnType<typeof meterView>,
  mode: string,
  out: { decisions: never[] },
  now: number,
) => LevelingStatusV2;

async function statusFor(state: MeterState, now: number, genLimitAmps = 16): Promise<LevelingStatusV2> {
  const controller = new LevelingControllerV2(createMockPool({ gridLimitAmps: 30, genLimitAmps, marginAmps: 0 }), createDeps());
  await controller.ensureLoaded();
  const c = controller as unknown as { meterState: MeterState; buildStatus: BuildStatus };
  c.meterState = state;
  return c.buildStatus.call(controller, [], meterView(state, now), "normal", { decisions: [] }, now);
}

describe("LevelingControllerV2 status: derate made visible (2026-09-27)", () => {
  const readings = Array.from({ length: 8 }, () => 12);

  it("keeps limitAmps as the ENFORCED limit and adds the configured limit and the live derate", async () => {
    const until = T0 + 5 * 60_000;
    const state = stateWith({
      source: "gen",
      lastReadingAt: T0,
      recent: readings,
      derate: { source: "gen", amps: 1, until },
    });
    const status = await statusFor(state, T0);
    expect(status.limitAmps).toBe(15);
    expect(status.configuredLimitAmps).toBe(16);
    expect(status.derateAmps).toBe(1);
    expect(status.derate).toEqual({ collapseAmps: 1, strainAmps: 0 });
    expect(status.derateClearsAt).toBe(until + COLLAPSE_DERATE_MS);
  });

  it("carries the strain share separately", async () => {
    const state = stateWith({
      source: "gen",
      lastReadingAt: T0,
      recent: readings,
      derate: { source: "gen", amps: 1, until: T0 + 60_000 },
      strainDerate: { source: "gen", amps: 0.5, until: T0 + 60_000 },
    });
    const status = await statusFor(state, T0);
    expect(status.limitAmps).toBe(14.5);
    expect(status.derateAmps).toBe(1.5);
    expect(status.derate).toEqual({ collapseAmps: 1, strainAmps: 0.5 });
  });

  it("reports zero derate and null breakdown when the line is at full rating", async () => {
    const state = stateWith({ source: "gen", lastReadingAt: T0, recent: readings });
    const status = await statusFor(state, T0);
    expect(status.limitAmps).toBe(16);
    expect(status.configuredLimitAmps).toBe(16);
    expect(status.derateAmps).toBe(0);
    expect(status.derate).toBeNull();
    expect(status.derateClearsAt).toBeNull();
  });

  it("does not show a gen derate while on the grid", async () => {
    const state = stateWith({
      source: "grid",
      lastReadingAt: T0,
      recent: readings,
      derate: { source: "gen", amps: 1, until: T0 + 60_000 },
    });
    const status = await statusFor(state, T0);
    expect(status.limitAmps).toBe(30);
    expect(status.configuredLimitAmps).toBe(30);
    expect(status.derateAmps).toBe(0);
    expect(status.derate).toBeNull();
  });

  it("has no configured limit when there is no source", async () => {
    const status = await statusFor(initialMeterState(), T0);
    expect(status.source).toBe("none");
    expect(status.limitAmps).toBeNull();
    expect(status.configuredLimitAmps).toBeNull();
    expect(status.derateAmps).toBe(0);
    expect(status.derate).toBeNull();
    expect(status.derateClearsAt).toBeNull();
  });

  // effectiveLimit never goes below 1 A, so the raw derate can exceed what is
  // actually enforced. The chip must report the real reduction.
  it("reports the ENFORCED reduction at the 1 A floor, keeping the raw breakdown", async () => {
    const until = T0 + 60_000;
    const state = stateWith({
      source: "gen",
      lastReadingAt: T0,
      recent: readings,
      derate: { source: "gen", amps: 1, until },
    });
    const status = await statusFor(state, T0, 1);
    expect(status.limitAmps).toBe(1);
    expect(status.configuredLimitAmps).toBe(1);
    expect(status.derateAmps).toBe(0);
    expect(status.derate).toEqual({ collapseAmps: 1, strainAmps: 0 });
    expect(status.derateClearsAt).toBe(until + COLLAPSE_DERATE_MS);
  });

  it("a partially clamped derate reports configured minus enforced", async () => {
    const state = stateWith({
      source: "gen",
      lastReadingAt: T0,
      recent: readings,
      derate: { source: "gen", amps: 1, until: T0 + 60_000 },
    });
    const status = await statusFor(state, T0, 1.5);
    expect(status.limitAmps).toBe(1);
    expect(status.derateAmps).toBe(0.5);
    expect(status.derate).toEqual({ collapseAmps: 1, strainAmps: 0 });
  });
});
