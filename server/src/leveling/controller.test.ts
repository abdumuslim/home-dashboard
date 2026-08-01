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

function createGradePool(
  configExtra: Record<string, unknown> = {},
  shedIds: string[] = [],
  /** Seed rows keyed like the CostBook: `${deviceId}|${source}|${transition}`. */
  book: Record<string, { ewmaAmps: number; samples: number; updatedAt: number }> = {},
) {
  const journal: Array<Record<string, unknown>> = [];
  const costs: Array<{ deviceId: string; transition: string; ewma: number }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
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

      await run(10, 8); // settle; recon confirms L1
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
