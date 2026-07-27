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

function createGradePool(configExtra: Record<string, unknown> = {}, shedIds: string[] = []) {
  const journal: Array<Record<string, unknown>> = [];
  const costs: Array<{ deviceId: string; transition: string; ewma: number }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
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
      journal.push({ reason: params[4], commands: params[7], decisions: params[8] });
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
