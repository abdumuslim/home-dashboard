// R6 (2026-09-27): the controller's meter-event handlers read the collapse
// derate as `meterState.derate?.amps` with no source check, while the
// source_change handler already used `derateFor(state, source, now)`. The derate
// record carries ONE source, so a batch holding a collapse on one line, a source
// change and a collapse on the other printed and pushed the OTHER line's derate
// for the first collapse; a strain derate on gen subtracted a grid breaker's
// derate from the gen limit. The ingest is scripted here so the mixed-source
// batch can be staged exactly; everything else in sensing.js is the real module.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { logLines, scripted } = vi.hoisted(() => ({
  logLines: [] as string[],
  scripted: { next: null as null | { state: unknown; events: unknown[] } },
}));

vi.mock("../logger.js", () => {
  const capture = (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  };
  return { childLogger: () => ({ info: capture, warn: capture, error: capture, debug: capture }) };
});

vi.mock("./sensing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sensing.js")>();
  return {
    ...actual,
    ingestReading: (...args: Parameters<typeof actual.ingestReading>) => {
      if (scripted.next == null) return actual.ingestReading(...args);
      const out = scripted.next;
      scripted.next = null;
      return out as ReturnType<typeof actual.ingestReading>;
    },
  };
});

import { LevelingControllerV2 } from "./controller.js";
import { initialMeterState } from "./sensing.js";
import type { LevelingDeps } from "./api.js";
import type { MeterState } from "./types.js";

function createController() {
  const pushes: string[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM ac_leveling_config") && sql.includes("id IN (1, 2)")) {
      return {
        rows: [{ id: 2, config: { controller: "v2", enabled: true, gridLimitAmps: 30, genLimitAmps: 15, marginAmps: 0.1 } }],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO ac_leveling_journal")) return { rows: [{ id: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const deps: LevelingDeps = {
    getTclCloud: () => null,
    broadcast: async (payload: Record<string, unknown>) => {
      pushes.push(String(payload.body ?? ""));
    },
    setDevicePowerCache: () => undefined,
    isManualOffLocked: async () => false,
    onLevelerFanCommand: () => undefined,
  };
  const controller = new LevelingControllerV2({ query } as never, deps);
  return { controller, pushes };
}

/** A meter state carrying one collapse-derate record and one strain record. */
function stateWith(now: number, derate: { source: "grid" | "gen"; amps: number } | null, strain: { source: "grid" | "gen"; amps: number } | null): MeterState {
  const base = initialMeterState();
  return {
    ...base,
    source: "gen",
    lastReadingAt: now,
    derate: derate == null ? null : ({ ...derate, until: now + 60 * 60_000 } as MeterState["derate"]),
    strainDerate: strain == null ? null : { ...strain, until: now + 60 * 60_000 },
  } as MeterState;
}

beforeEach(() => {
  logLines.length = 0;
  scripted.next = null;
});

describe("R6: meter-event handlers read the derate of the event's OWN source", () => {
  it("a grid collapse in a batch whose record now belongs to gen does not claim gen's derate", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-27T16:00:00Z"));
      const { controller, pushes } = createController();
      await controller.ensureLoaded();
      const now = Date.now();
      // grid collapse → changeover → gen collapse, in ONE ingest: the single
      // derate record ends the batch describing gen (4 A).
      scripted.next = {
        state: stateWith(now, { source: "gen", amps: 4 }, null),
        events: [
          { kind: "collapse", fromAmps: 28, toAmps: 1, source: "grid" },
          { kind: "source_changed", from: "grid", to: "gen" },
          { kind: "collapse", fromAmps: 14, toAmps: 1, source: "gen" },
        ],
      };
      controller.onPowerReading({ current_1: 0, current_2: 1 });
      await vi.advanceTimersByTimeAsync(0);

      // The gen collapse reports gen's own derate: 15 - 4 = 11 A.
      expect(pushes.some((p) => p.startsWith("Generator tripped") && p.includes("11.0A"))).toBe(true);
      // The grid collapse must not print 30 - 4 = 26 A: that is gen's record.
      expect(pushes.some((p) => p.includes("26.0A"))).toBe(false);
      expect(logLines.some((l) => l.includes("on grid") && l.includes("26.0A"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a gen strain derate is judged against gen's derates, not a grid breaker's", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-27T16:00:00Z"));
      const { controller } = createController();
      await controller.ensureLoaded();
      const now = Date.now();
      scripted.next = {
        state: stateWith(now, { source: "grid", amps: 5 }, { source: "gen", amps: 1.5 }),
        events: [{ kind: "strain_derate", amps: 1.5, source: "gen", gapMs: 12_000, preGapAmps: 14.4 }],
      };
      controller.onPowerReading({ current_1: 0, current_2: 14 });

      const line = logLines.find((l) => l.includes("Generator strain on gen"));
      expect(line).toBeDefined();
      // gen limit 15, no gen collapse derate, 1.5 A strain → 13.5 A (the old read gave 15 - 5 - 1.5 = 8.5 A).
      expect(line).toContain("limit now 13.5A");
    } finally {
      vi.useRealTimers();
    }
  });
});
